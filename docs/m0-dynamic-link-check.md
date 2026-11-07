# M0: Dynamic Link check (manual, owner)

Purpose: see whether a 60-minute, data-baked AE comp stays usable in Premiere Pro 2026 through
Dynamic Link, which is the main delivery path. This is not automated. Allow about 10 minutes.

**What you need:** the spike project `work/volt-hud/ae/spike/out/hud-baked-60.aep`, made by
`ae/spike/run-ae.sh baked out/synth-60.json out/hud-baked-60.aep`. It holds one comp, `VOLT HUD`:
1920x1080, 29.97 fps, 60:00 long, with synthetic data only. Grey `[no data]` gaps are at
0:00–0:20, 30:00–30:30 and 59:35–60:00. Close it in After Effects first, or leave AE closed.

1. **Import.** In a new Premiere project, use File > Adobe Dynamic Link > Import After Effects Composition.
   Pick `hud-baked-60.aep`, then `VOLT HUD`. Note how many seconds pass before the item appears in
   the bin.
2. **Place it.** Make a 1080p 29.97 sequence. Put any 1080p clip on V1 (a reframed ride MP4 if you have one).
   Put the comp on V2 at 00:00. Check that the comp clip is 60:00 long and that V1 shows through
   around the widgets (alpha works).
3. **Scrub.** Drag the playhead across the whole hour, then click to 01:00, 29:50, 30:10 and 59:20.
   For each, note roughly how long the HUD takes to show the new frame. The speed, power, battery and clock must change, and 30:10 must
   show grey `[no data]`.
4. **Play.** Play 20 s from 10:00 at Full, then at 1/2 playback resolution. Note whether it plays
   in real time, stutters, or drops frames. (Turn on Settings (wrench) > Show Dropped Frame Indicator.)
5. **Note the lag.** Write down: the import time, a typical scrub delay (instant / under 1 s / several seconds), whether playback is real time
   at Full and at 1/2, and anything odd. Then close Premiere without saving, or save to a scratch folder.

Pass if scrubbing settles in under about 1 s and 1/2-resolution playback is close to real time.
If it fails, the fallbacks are render-and-replace (Clip > Render and Replace, short ranges only) or
a pre-rendered ProRes 4444 preview for the section you are editing. Long ProRes renders stay off
the table.
