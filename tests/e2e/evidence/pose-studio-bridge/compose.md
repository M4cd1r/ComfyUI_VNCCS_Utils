# pose-studio-bridge evidence — provenance

Local-only (gitignored) copy of the Task 8 Before/After evidence. Both halves are the
**same crop at the same scale**: one rectangle (x 380, y 120, 1320x960) cut out of two
1700x1100 probe screenshots taken with the same viewport and the same canvas view state
(both show `move 86% 1024x1024`, the same UI chrome and the same dashed layer frame), then
composed with the documented pipeline:

    node evidence.mjs --topic pose-studio-bridge --phase compose

| file | content |
|---|---|
| `before.png` | crop of `tests/e2e/evidence/pose-studio-probe/11-after-captures.png` (main checkout, PRE-fix merged build 2fc708d) — mannequin squeezed to a 5x29 px sliver by the bridge pushes |
| `after.png` | crop of `after-captures.png` in this directory (this worktree, POST-fix, `vnccs-t8-comfyui-1` on 0.0.0.0:8197) — mannequin intact at 324x508 px |
| `pose-studio-bridge.pair.png` | labelled `Before` / `After` pair produced by the compose phase (1700x900) |
| `pose-studio-bridge.after.png` | standalone labelled `After` figure from the same compose run |
| `geometry.json` | the exact crop rectangle, both source files and the measured mannequin bbox inside the crop |
| `after-captures.png`, `after-first-save.png` | full post-fix screenshots (1700x1100) the After half was cut from |
| `probe-report-after.json`, `probe.json` | the measured bridge-push geometry on the live instance |

The predecessor's pair (1900x900, custom composition) was replaced: its After half measured a
2.27x larger mannequin than the standalone `<topic>.after.png` produced from the same figure
element, i.e. the two files did not come from the documented pipeline and their relative scale
was unverifiable. `before.png`/`after.png` above are equal-size crops, so the compose phase
scales both halves by exactly the same factor.
