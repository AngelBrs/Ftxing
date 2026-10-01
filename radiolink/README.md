# RADIOLINK

A digital amateur-radio terminal that runs in the browser and works over **ordinary acoustic
coupling**: the computer/phone speaker feeds the radio's microphone, and the radio's speaker feeds
the computer/phone microphone. No sound-card interface is required (though one makes it far better).

It implements **real, standards-compliant FT8, FT4 and JS8 encoding and decoding in TypeScript** —
no simulated decoders, no fake demo data. Everything you see in the UI comes from the actual
demodulator running on real audio.

---

## What is real, and what is not

| Claim | Status |
| --- | --- |
| FT8 encode | **Real.** Bit-exact against `kgoba/ft8_lib` reference vectors (77-bit pack → CRC-14 → LDPC(174,91) → Gray → Costas → GFSK). |
| FT8 decode | **Real.** Decodes WAV files produced by `ft8_lib`'s `gen_ft8`, and `ft8_lib`'s `decode_ft8` decodes ours. |
| FT4 encode/decode | **Real.** Includes the 10-byte XOR scramble, the four 4-symbol Costas arrays and ramp symbols. Verified bidirectionally against `ft8_lib`. |
| JS8 (Normal / Fast / Turbo) | **Real.** Frame format from `js8call`'s `genjs8.f90`: 12×6-bit chars + i3 + CRC-12(⊕42) + LDPC(174,87), no Gray mapping, S7/D29/S7/D29/S7 structure. Directed-message *networking* features (relay, store-and-forward, heartbeat automation) are **not** implemented — only the on-air frame format and free text. |
| FT2 | **Experimental and non-standard.** No published FT2 specification exists. This is FT8's source coding at 4× the speed (25 Hz spacing, 3.2 s frame in a 5 s slot). It interoperates **only** with other copies of this app. It is labelled as experimental everywhere in the UI. |
| Hardware PTT | **Real, but only where the platform allows it.** Web Serial RTS/DTR keying works in Chromium-based desktop browsers. Everything else uses VOX, or the optional local companion service (below). Browser JavaScript cannot control arbitrary radio hardware and the app never pretends otherwise. |

### Measured sensitivity (honest numbers)

50 % decode probability, AWGN, 2500 Hz reference bandwidth, measured with the bundled test harness:

| Mode | This decoder | Reference implementation |
| --- | --- | --- |
| FT8 | **≈ −18.5 dB** | WSJT-X −21 dB |
| FT4 | **≈ −14 dB** | WSJT-X −17.5 dB |
| JS8 Normal | **≈ −18 dB** | JS8Call ≈ −24 dB |
| JS8 Fast | ≈ −16 dB | — |
| FT2 | ≈ −5 dB | (no reference exists) |

So: this is a genuine weak-signal decoder, but it is 2–6 dB less sensitive than the reference C/Fortran
implementations. The UI states these numbers rather than quoting WSJT-X's.

---

## Signal path

```
radio speaker ──► mic ──► getUserMedia (echoCancellation/noiseSuppression/AGC all OFF)
                          └─► AudioWorklet (2048-sample frames)
                              └─► Web Worker  ── 45 s ring buffer @ 12 kHz
                                  ├─ DSP: DC block · hum-harmonic notch · birdie notch
                                  │        200–3200 Hz band-pass · fading/dropout/tilt stats
                                  │        gain normalisation to −20 dBFS
                                  ├─ slot scheduler locked to UTC (drift corrected)
                                  ├─ per-mode Costas sync search (time/freq 2× oversampled)
                                  ├─ soft-decision LLRs → BP min-sum (45 iters) → OSD order 1
                                  └─ CRC + tone-match verification → decodes
                                      └─► UI: waterfall · decode list · diagnostics
```

Transmit is the mirror image: text → pack77/JS8 frame → CRC → LDPC → symbols → GFSK synthesis →
`AudioBuffer` → chosen output device, with PTT keyed before and released after.

### Design rules that are enforced in code

* **No blanket noise reduction.** Notches are only applied to narrow, verified interferers (mains
  harmonics below 420 Hz that are ≥ 12 dB above the local floor *and* narrower than a digital
  signal, plus steady carriers). A 50 Hz-wide FSK signal can never be notched away.
* **Never transmits by itself.** Every transmission requires a click. `TRANSMIT` waits for the next
  slot boundary, `Transmit now` is unaligned; both show a countdown, a red `TX ACTIVE` banner and a
  full-width `STOP TX` control, and there is a hard maximum-duration cut-off.
* **Honest failures.** The decoder never says "no signal". It says which mode was detected, at what
  frequency, with what sync score and confidence, and why it failed — e.g.
  *"FT8 signal detected at 1188 Hz but synchronization/decoding failed — timing is off by 1.3 s,
  check the computer clock"*, or *"Possible weak FT8 signal near 1500 Hz — estimated SNR −14 dB,
  below the decode threshold"*, or *"No digital signals found — band appears to be just noise
  (peak 2 dB above floor)"*.
* **No mode is "best".** AUTO picks a mode from your stated purpose and the measured conditions and
  lists the reasons and the alternatives it rejected.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # production bundle in dist/
```

First run opens the six-step **audio setup wizard**: RX input → TX output → background-noise
measurement → test signal → automatic gain recommendation → save calibration.

### Optional companion service (real hardware PTT / CAT)

```bash
rigctld -m 2028 -r /dev/ttyUSB0 -s 38400      # your rig; `rigctl -l` lists model numbers
node companion/server.js --port 8737          # dependency-free WebSocket ↔ rigctld bridge
```

Then choose *Hardware PTT → companion service* in Settings → PTT. Without it you can still use
**VOX** (the radio keys on transmit audio) or **Web Serial RTS/DTR** on desktop Chromium.

---

## Tests

```bash
npx tsx test/encode.test.ts      # reference-vector comparison against ft8_lib output
npx tsx test/decode.test.ts      # decode of synthesised and ft8_lib-generated signals
npx tsx test/js8.test.ts         # JS8 frame round-trip and sensitivity
npx tsx test/interop.ts          # bidirectional interop with ft8_lib binaries
npx tsx test/sens.ts             # sensitivity sweep (the numbers in the table above)
npx tsx test/realworld.test.ts   # full pipeline against deliberately degraded audio
npx tsx test/resample.ts         # resampler accuracy
```

`test/realworld.test.ts` is the interesting one: it runs the complete DSP + decoder chain against
mains hum, clipping, DC offset, AGC pumping, fading, mid-frame dropouts, a phone-microphone
frequency response, birdies, a 48 kHz resample round trip, three overlapping signals, a 2-second
timing error, and pure noise. Current result: **12/12 scenarios behave correctly**, including the
noise-only case, which must produce *no* decodes and an honest explanation.

The browser end of the chain is verified too: with Chromium's `--use-file-for-fake-audio-capture`
fed a generated on-air recording, the running app decodes `CQ SV1ABC KM17`, `SV1ABC DL2XYZ -11` and
`DL2XYZ SV1ABC R-09` at 1200 Hz and 1875 Hz with dt ≈ 0.0 s, live, through getUserMedia.

---

## Practical operating notes

* **Clock accuracy matters more than anything else.** FT8/FT4/JS8 need the PC clock within ~1 s
  of UTC. The diagnostics panel tells you when timing looks wrong.
* Acoustic coupling works, but keep the room quiet and the levels moderate: aim for −20 to −12 dBFS
  RX level and **0 % clipping**. The wizard sets this up for you.
* Transmit only on frequencies and modes you are licensed for, and only with your own callsign.
