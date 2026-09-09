# Missing things

Documentation and release-readiness checklist, reviewed 9 September 2026.
Checked items below are implemented in the website or verified in host-side tests.
Unchecked items need an implementation, a release decision, or physical testing.
Writing instructions or compiling code does not complete a hardware acceptance test.

## Completed in this documentation pass

- [x] Replace open-hardware marketing with “Simple UWB,” including metadata and branding.
- [x] Make the documentation entry point task-based: Distance, Location, Python, ROS 2.
- [x] Keep the same documentation navigation on every page.
- [x] Explain DFU versus serial mode, role selection, expected output, units, and port ownership.
- [x] Document the 0–5 m graph bounds and the difference between chart and static-test exports.
- [x] Add a Location quickstart: survey, 2D height, anchor IDs, flashing, calibration, and data limitations.
- [x] Document Location serial commands separately from the Distance command set.
- [x] Explain that runtime calibration, browser storage, and Python storage are different.
- [x] Correct the firmware clock documentation: ranging roles use 144 MHz; CAN examples use 170 MHz.
- [x] Remove misleading source-file links that only opened the GitHub organization.
- [x] Make current firmware and ROS source-package access a prerequisite, not a presumed public download.
- [x] Add a Python calibration collection timeout and require device acknowledgement before saving an offset.
- [x] Verify restored calibration with fresh INFO output; add info.py --no-restore for boot-state checks.
- [x] Propagate dfu-util errors instead of reporting an unconfirmed flash as successful.
- [x] Rebuild and test the downloadable host-tools ZIP against the individual files.
- [x] Add documentation-link, navigation, example-syntax, and host-tool regression checks to publication.
- [x] Include Privacy and Terms in the Pages artifact; they were previously absent from the copy list.

## P0 — complete before calling setup fully self-service

- [ ] **Decide how to distribute the current software.** The current firmware checkout is private;
  the public opentag repository contains older material and does not supply the documented
  STM32/Embassy and ROS packages. Publish a reviewed, software-only release with licenses and
  versioned download links, or establish an explicit source-access process. Do not publish the
  private hardware/business checkout as a shortcut. Acceptance: a new customer can obtain the
  documented package without guessing a repository or missing dependency.
- [ ] **Run the quickstarts on fresh systems.** Record OS/browser versions, DFU permissions,
  serial permissions, both role IDs, firmware, and expected output. Cover desktop Chrome/Edge
  on the supported operating systems; write the exact Windows DFU and Linux permission steps
  from those tests. Acceptance: flash, reconnect, measure, calibrate, export, and recover after
  unplugging without undocumented intervention.
- [ ] **Validate ROS 2 Jazzy end to end.** The local source has parser/transport tests, but a
  release needs a clean ROS workspace build plus distance/location and disconnect/reconnect
  checks. Verify topic units, timestamps, frame convention, diagnostics, and services against
  each firmware role. Acceptance: archive build/test results and a short hardware recording.
- [ ] **Make performance reporting count outages.** Both browser app.js and Python summarize()
  use the first-to-last-sample window and an ambiguous 8-bit sequence. Track the complete
  observation interval, longest outage, device attempts/completions, and host drops separately;
  distinguish unknown loss from zero loss. Acceptance: a ten-second run with samples only in
  its first second cannot report uninterrupted 40 Hz / 100% success. Include zero-sample tests.

## P1 — firmware and calibration reliability

- [ ] **Bound TX waits and recover the radio.** Add timeouts, error-specific diagnostics, and a
  tested abort/reinitialization path; use a watchdog as a fallback. An idle responder waiting
  for its first poll is not itself a fault. Test a silent peer, missed delayed TX, and bus errors.
- [ ] **Handle timestamp wrap safely.** Mask aligned delayed-transmit timestamps back to 40 bits
  in both TWR roles. Add boundary tests around zero and 2^40; preserve delayed-TX alignment.
- [ ] **Preserve invalid/negative range information.** Current corrected negative ranges become
  ordinary zero readings. Define diagnostic/validity semantics and update host parsers before
  changing the wire format. Test calibration near zero and malformed timestamps.
- [ ] **Persist calibration on device.** Use a versioned, checksummed record with power-failure
  handling and explicit save semantics. The browser DFU path mass-erases flash, so firmware
  updates also need a preservation/migration policy. Acceptance: the same offset is present
  after power cycling with no browser/Python restoration and after the supported update path.
- [ ] **Bind calibration and traffic to the right devices.** Distance offsets are fitted to a
  pair but saved by responder ID. Add pair/PHY metadata, stale-calibration checks, and explicit
  peer/session identity. Test swapping an initiator and two nearby active pairs.
- [ ] **Strengthen host transport handling.** Retain partial serial lines across read timeouts,
  validate record bounds and calibration-store contents, and bound command/calibration input.
  Test fragmented records, disconnects, corrupt saved JSON, and zero-sample static tests.

## P1 — Location installation workflow

- [ ] **Save and restore installation profiles.** Store the room, surveyed anchors, dimensions,
  tag height, device/anchor identities, and calibration together. Current saved biases are keyed
  only by 2D/3D mode; room changes rescale anchors and reloads do not restore the survey.
  Acceptance: switching rooms cannot silently reuse another installation's calibration.
- [ ] **Export live Location data.** Add a real P/MISS logger or browser export with survey,
  calibration, units, valid/missing records, and timestamps. Current live browser history is
  bounded to 2,000 rows; the Python tools are distance-only. Acceptance: retain a complete
  timed run and re-import it without losing metadata or failures.
- [ ] **Separate static truth from moving-path truth.** The live accuracy view compares every fix
  with one entered point. Make that mode explicit and require time-aligned ground truth for a
  trajectory. Label synthetic examples distinctly. Validate both 2D and 3D on surveyed points.

## P2 — finish the product reference

- [ ] **Publish a verified wiring reference.** Add an annotated connector/BOOT0/SWD photo,
  pin-1 orientation, mating connector/part, mounting reference points, and the applicable board
  identifier. Verify input range, current/power, polarity protection, USB/J2 coexistence, and
  environmental limits; do not infer operating ratings solely from component maximums.
- [ ] **Publish the evidence behind performance claims.** Link normalized raw July baseline
  CSVs and a separate current-profile run. Include pair IDs, calibration, geometry, environment,
  full observation duration, failures, mean error, spread, and P95 absolute error. Add independent
  pairs, warm-up/temperature, orientations, obstructions, and longer distances over time.
- [ ] **Release range-over-CAN separately.** Define IDs, payloads, units, byte order, node identity,
  cadence, error/health reporting, and bus timing; implement and validate them. Existing CAN
  echo/load examples are not a ranging protocol.
- [ ] **Optimize rate after a reliable baseline.** Keep the current PHY fixed; reduce the 8 ms
  inter-range guard one step at a time and compare accuracy and complete-run delivery. Treat
  50 Hz as an experiment until it passes. Shorter reply delays, IRQ-driven waiting, and faster
  SPI require their own measurements; they are not documentation fixes.

## Verification for this change

Run from the website repository root in a Python environment with requirements installed:

```sh
python -m pip install -r docs/scripts/requirements.txt
python -m unittest discover -s tests -v
git diff --check
```

The automated suite does not connect to, flash, or claim validation of a physical module.
Hardware firmware and private source publication are intentionally outside this website change.
