"""Reconnect-capable serial transport used by the ROS node."""

from __future__ import annotations

import queue
import threading
from dataclasses import dataclass

import serial


@dataclass(frozen=True)
class SerialLine:
    text: str


@dataclass(frozen=True)
class ConnectionState:
    connected: bool
    message: str


TransportEvent = SerialLine | ConnectionState


class SerialTransport:
    """Read serial data in a worker thread and reconnect after failures."""

    def __init__(
        self,
        *,
        port: str,
        baud_rate: int,
        timeout_s: float,
        reconnect_interval_s: float,
        queue_size: int = 4096,
    ) -> None:
        self.port = port
        self.baud_rate = baud_rate
        self.timeout_s = timeout_s
        self.reconnect_interval_s = reconnect_interval_s
        self.events: queue.Queue[TransportEvent] = queue.Queue(maxsize=queue_size)
        self.queue_drops = 0

        self._serial: serial.SerialBase | None = None
        self._serial_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    @property
    def connected(self) -> bool:
        with self._serial_lock:
            return self._serial is not None and self._serial.is_open

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="opentags-serial", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._close()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=max(2.0, self.timeout_s * 2.0))

    def write_command(self, command: str) -> tuple[bool, str]:
        payload = (command.strip() + "\n").encode("ascii")
        with self._serial_lock:
            if self._serial is None or not self._serial.is_open:
                return False, "serial port is not connected"
            try:
                self._serial.write(payload)
                self._serial.flush()
            except (OSError, serial.SerialException) as error:
                return False, f"serial write failed: {error}"
        return True, f"sent {command.strip()}"

    def _emit(self, event: TransportEvent) -> None:
        try:
            self.events.put_nowait(event)
        except queue.Full:
            self.queue_drops += 1
            try:
                self.events.get_nowait()
            except queue.Empty:
                pass
            try:
                self.events.put_nowait(event)
            except queue.Full:
                self.queue_drops += 1

    def _run(self) -> None:
        if not self.port:
            self._emit(ConnectionState(False, "parameter 'port' is empty"))
            return

        while not self._stop.is_set():
            try:
                connection = serial.serial_for_url(
                    self.port,
                    baudrate=self.baud_rate,
                    timeout=self.timeout_s,
                    write_timeout=1.0,
                )
                with self._serial_lock:
                    self._serial = connection
                self._emit(ConnectionState(True, f"connected to {self.port}"))

                while not self._stop.is_set():
                    payload = connection.readline()
                    if payload:
                        self._emit(SerialLine(payload.decode("utf-8", errors="replace").strip()))
            except (OSError, serial.SerialException) as error:
                if not self._stop.is_set():
                    self._emit(ConnectionState(False, f"serial error: {error}"))
            finally:
                self._close()

            if not self._stop.wait(self.reconnect_interval_s):
                self._emit(ConnectionState(False, f"reconnecting to {self.port}"))

    def _close(self) -> None:
        with self._serial_lock:
            connection = self._serial
            self._serial = None
            if connection is not None:
                try:
                    connection.close()
                except (OSError, serial.SerialException):
                    pass
