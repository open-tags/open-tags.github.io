import queue
import time
import unittest

from opentags_driver.transport import ConnectionState, SerialLine, SerialTransport


class SerialTransportTest(unittest.TestCase):
    def test_loopback_connect_write_read_and_stop(self) -> None:
        transport = SerialTransport(
            port="loop://",
            baud_rate=115200,
            timeout_s=0.05,
            reconnect_interval_s=0.1,
        )
        transport.start()
        try:
            connected = self._next_event(transport, ConnectionState)
            self.assertTrue(connected.connected, connected.message)

            success, message = transport.write_command("PING")
            self.assertTrue(success, message)

            line = self._next_event(transport, SerialLine)
            self.assertEqual(line.text, "PING")
        finally:
            transport.stop()

        self.assertFalse(transport.connected)

    @staticmethod
    def _next_event(
        transport: SerialTransport,
        expected_type: type[ConnectionState] | type[SerialLine],
    ) -> ConnectionState | SerialLine:
        deadline = time.monotonic() + 2.0
        while time.monotonic() < deadline:
            try:
                event = transport.events.get(timeout=0.2)
            except queue.Empty:
                continue
            if isinstance(event, expected_type):
                return event
        raise AssertionError(f"timed out waiting for {expected_type.__name__}")


if __name__ == "__main__":
    unittest.main()
