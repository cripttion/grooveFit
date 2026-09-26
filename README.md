# Groove Fit — dance-fitness game prototype (web)

Dance along with a workout video shown on the big screen. The side panel shows the
pose of the dancer in the video as a soft **target silhouette**. Your own body, tracked
from the webcam, appears as a dark silhouette with a neon outline on top of it. Each limb
turns **green** when it matches.

## Run

```bash
node server.js
```

Then open http://localhost:5173 (Chrome recommended) and allow the camera.
The camera only works on `localhost` or HTTPS.

No build step and no npm install. MediaPipe loads from jsDelivr.

## Modes

| Mode | Silhouettes come from | Reference video |
|---|---|---|
| **Quick Groove** + `choreographies/<youtubeId>.json` present | the real dancer in that video (pre-extracted) | YouTube embed, synced by time |
| **Quick Groove** (no JSON) | built-in routine at 128 BPM (16 named moves) | YouTube embed as music/visual |
| **Learn From Video** | any video file you drop in, analyzed in the browser | the local file, or YouTube if "play through YouTube" is ticked |
| **Auto-dancer demo** | either of the above | — (no camera, a bot silhouette plays itself) |

`choreographies/v3SGmJPDNVw.json` ships with the prototype. It is the first
5 minutes of the Eleni Fit *20 MIN Sweaty Cardio Dance* video, so Quick Groove
uses the real moves out of the box.

### Making a choreography for another video
1. Download the video (e.g. `yt-dlp -f "b[height<=720][ext=mp4]" -o media/<id>.mp4 <url>`).
2. In the app choose **Learn From Video**, tick *play through YouTube*, and drop the file.
3. When analysis finishes, click **Export JSON** and save it as
   `choreographies/<youtubeId>.json`. Or call
   `PUT /choreographies/<id>.json` on the dev server. From then on the YouTube
   link alone gives video-accurate silhouettes.

## Training plan

A session isn't just "play the video". The video is cut into **steps** of 4 key moves
(about one 8-count). You learn them, mix them, and finish with the whole video:

| Level | What you do | Reps |
|---|---|---|
| Learn Step 1 | one step, looped | ×3 |
| Learn Step 2 | next step | ×3 |
| Combo 1 + 2 | both steps back-to-back, as in the video | ×2 |
| Learn Step 3, 4 | … | ×3 |
| Combo 3 + 4 | … | ×2 |
| Mix it up | all learned steps in a random order | ×2 |
| **FINAL** | the whole video (or the first 1 / 3 min) | ×1 |

* Before every rep, a get-ready card shows the level, the rep number, your last rep's score
  and a countdown. The video jumps to the right spot while the card is up, so you never see it skip.
* If a new step goes badly (best rep < 55%), the plan adds **one bonus rep** before moving on.
* The music always plays at normal speed and the silhouettes stay locked to the video.
* The results screen shows stars for every level.
* In the menu, choose **Steps to learn** (3 / 4 / 6) and the **Final round** length, or pick
  "Just dance the video" to skip practice. The menu previews the plan with timings.
* Plan logic lives in `js/plan.js`: `splitSteps` → `buildPlan` → `buildQueue`.

## How it works

```
webcam ─► MediaPipe Pose (lite, GPU) ─► canonical body ─┬─► your silhouette on stage (per-limb match colors)
                                                         ├─► pose match vs. target ─► score / combo / fever
video ─► MediaPipe Pose (full, offline scan) ─► timeline ┴─► ghost silhouette + move pictograms
                                                           └─► tracked skeleton drawn over the video
```

* **Canonical body** (`js/pose.js`): hip-centered, scaled by torso length,
  with joints named by *screen side*. A mirrored selfie and an un-mirrored
  video can then be compared directly. You mirror the dancer, as in Just Dance.
* **Scoring** (`js/scoring.js`): compares limb *directions* (upper arms,
  forearms, thighs, shins, torso), so it doesn't depend on body size or distance.
  It tolerates up to 0.5 s of reaction lag. Legs only count when the camera sees them.
* **Judging**: each key move has a window of −0.35 s to +0.75 s. The best match
  in that window gives PERFECT / GOOD / OK / MISS. Combos raise the multiplier,
  and filling the fever meter doubles points for 8 s.
* **Calories**: MET is estimated from how fast your wrists, ankles and head
  actually move, times your weight.

## Files

```
index.html         layout + overlays
css/style.css      neon game styling
js/main.js         game state machine, loop, UI wiring, plan playback
js/plan.js         training plan: steps, levels, clip queue
js/pose.js         MediaPipe setup, canonical body, smoothing
js/scoring.js      pose similarity + judgments
js/choreo.js       demo routine, video analysis, key-move picking, JSON save/load
js/stage.js        stage background, target + player silhouettes, move strip, overlays, FX
js/audio.js        WebAudio SFX + built-in beat
js/player.js       YouTube / local video behind one clock
server.js          static dev server (+ PUT for saving choreographies)
choreographies/    pre-extracted choreographies, keyed by YouTube id
media/             local video copies used for analysis (not needed at runtime)
```

## Ideas for next iterations
* Optional avatar skins (e.g. a rigged GLB authored in Blender) as an unlockable.
* Beat detection on the video audio so key moves land exactly on the music.
* Hand/finger tracking for claps and waves. Face tracking for the avatar's expressions.
* Progress over time: streaks, weekly calorie goals, unlockable outfits.
