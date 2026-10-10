---
name: video-prompt
description: Video prompt specification — generates a time-segmented video-generation prompt from storyboard-segment content, with cuts allowed within a segment
---

# Video Prompt (storyboard segment → video_prompt)

From a single storyboard segment's description (containing the 【镜头N】 sub-shot structure and dialogue/narration) / atmosphere / duration, generate the `video_prompt` that drives AI video generation. **One storyboard segment = one 8-15-second video, with cuts allowed inside it**: consecutive segments may be different shots (change of shot size/angle/subject), joined with hard cuts; but the whole segment **never crosses scenes** and never uses flashbacks.

> **Mandatory since 2026-10-09: produce BOTH versions in one batch.**
> `video_prompt` (Chinese working version — what the UI shows and the user edits) + `video_prompt_en` (English send version — what is actually sent for video generation).
> The English rules live in the "English send version (official H3 Ref2VA six sections + leading CAST/BLOCKING)" section at the end of this file; everything below is the Chinese version's rules.
> When saving you must pass three keys: `storyboard_id`, `video_prompt`, `video_prompt_en`.

## Format

The **first line of the `video_prompt` is the header**: first introduce which characters and scene appear in this video, then follow with the time segments. Characters and scenes are always referenced with @ (during generation they are replaced with the corresponding reference-image markers, so the video model first locks onto "who" and "where").

```
Characters: @Xiaoming, @Xiaohong; Scene: @Coffee Shop.
0-3s: @Coffee Shop, close shot, static camera; @Xiaoming looks down at his phone, fingers repeatedly tapping the table, expression anxious.
3-6s: Cut to a wide shot of the doorway; the doorbell rings as @Xiaohong pushes the door open and walks in, bringing in a gust of cold air.
6-9s: Cut back to a medium shot; @Xiaohong walks over with a smile and sits down across from Xiaoming; Xiaoming says: "You finally made it."
```

Header rules:
- Only list the characters who actually appear in this storyboard segment and the bound scene — do not list those who do not appear
- When a prop has a notable appearance, it may be appended to the header (e.g. `; Props: @Letter`)
- The header is its own line, ending with a period, followed by the time segments

Split into 3-second segments, each segment on its own line separated by newlines, with time ranges continuous and adjoining (no overlaps, no gaps).

## Mapping to the Storyboard Description

The `description` is the sole content source of the video_prompt (visuals, actions, dialogue, and narration are all in it). Conversion rules:

- Each `【镜头N】` in the `description` maps to **1-2 consecutive 3-second segments** — same order, no omissions, no merging, no new sub-shots
- Dialogue/narration is extracted from the "CharacterName says: "..."" / "Narration: ..." entries inside the corresponding `【镜头N】` and assigned to that sub-shot's mapped segments; **do not invent new dialogue beyond the description**
- Visual actions follow the `description`; `atmosphere` is only used to supplement each segment's lighting, color tone, and mood descriptions

## Within-Segment Structure

Organize each segment's content in this order (items with no content may be omitted, but action/visuals are mandatory):

**Time range + scene @reference + shot size/camera move + character @reference + main action·expression + dialogue/narration + mood and lighting**

- **The first segment must establish the space**: scene + camera position + each character's position and state, so the audience knows at a glance where we are and whom to watch
- **Cuts**: start a post-cut segment with a transition word such as "cut to / cut back", and restate the shot size and subject; cut points should align with the `【镜头N】` structure in the storyboard `description`
- **Shot size/camera move**: one camera state per segment (close shot / medium shot / wide shot / close-up; static / push / pull / pan / tracking); the camera move is continuous within a single sub-shot and may change after a cut
- **Action**: one main action per segment, with concrete visible verbs (walk, turn around, look up, clench, pause)
- **All emotion must become visible description**: no abstract words like "he is very sad / the mood is tense" — write it as "he lowers his head, fingers clench the rim of the cup, breathing grows heavier"
- **Dialogue/narration**: write "CharacterName says: "line""; narration as "Narration: content"; a long line that cannot be spoken within 3 seconds is split across multiple segments; a segment without dialogue must still spell out "**no human voice in this segment, only … ambience**" (noting "machines keep roaring" alone is not enough — the model assumes you forgot the voices and invents speech)

## Reference Rules

- `@SceneName` — scene reference; the name must exactly match the location in the scene list
- `@CharacterName` — character reference; the name must exactly match the name in the character list
- `@PropName` — prop reference; the name must exactly match the name in the prop list; reference a prop when it is clearly visible in frame, used, or shown in close-up
- During generation, each `@name` is automatically replaced with the corresponding reference-image marker (e.g. `@Xiaoming` → `@Image1Xiaoming`), so names must match exactly — do not abbreviate or add extra symbols
- **Every segment must have at least one @ reference anchoring the frame**; any segment in which a character appears must @ that character; only reference scenes/characters/props already bound to this storyboard segment
- **Multi-character segments must declare each character separately**: write every character's own `@name` in the header, and make sure each character appearing in the body also gets `@name` at least once — **the name only, never a description**. The relay builds one `<Subject N>` identity per entity, which is what stops the reference images and cards from contaminating each other. Without it the model **averages several faces into one new face**.
- **🔴 The character board is headless — the video prompt must explicitly "restore the head" (2026-10-10)**: the three body views have **the head cleanly removed** (only the face close-up panel has a face) — **without pointing at the face panel and stating the head, the model may copy the headless reference and generate a headless character**:
  - On each character's first appearance, **point at `脸部特写格`** as the source of the face and head: `@LinQiao (this shot uses 脸部特写格)`
  - **Explicitly state that the character has a complete head and face** (inside that character's `<Subject N>` definition), e.g. `<Subject 2> is the young Chinese woman in <Picture 2>, with a complete head and face as shown in the face close-up panel, ...`
  - The board has **four panels** (left to right: face close-up / headless front full body / headless 90° left side full body / headless back full body); copy the panel name **verbatim** from: `脸部特写格` / `正面全身格` / `90度左侧面全身格` / `背面全身格` (close-up → face panel, full-body/medium → front full-body panel). **Never invent a panel**, **never name two panels at once**, never reword a panel name
- **The relay auto-assembles the official R2V skeleton from the header**: `subject_definitions` (`<Subject N>` = who it is, `<Picture N>` = the Nth reference image, `mod_N` = the Nth identity card — **all four share one number**), `retention_analysis: fully_preserved`, `detailed_description`, and it rewrites every `@name` in the body to `<Subject N>` — so the **header must be complete and its order must match the reference-image order**, or identities get bound to the wrong image

## Body slimming (mandatory, in force since 2026-10-08)

**Identity and appearance are not written in the body.** The body states only what happens and how it is filmed.

Three layers already lock "what it looks like"; repeating them in the body burns characters and can contradict them:

1. **Identity card**: `<Subject N>` ↔ the `mod_N` card slot (identity, hairstyle and outfit extracted from the character board)
2. **Reference image**: `<Picture N>`
3. **Machine-injected lock**: on submit, the relay pins the asset's `styling`/`appearance` and the scene's `prompt`/`lighting` verbatim into the tail of the prompt (`verbatim_lock`)

What the body SHOULD contain:

- Scene environment and lighting (may reference the scene asset, no fresh version per segment)
- Camera position, shot size, movement; character actions and performance; plot beats; dialogue/narration; ambience
- Exposure consistency: **once in the style sentence** (the one or two sentences before `[Shot 1]`: "consistent exposure and white balance throughout, no new light source"), **never repeated per shot** (wastes tokens, dilutes attention); cuts

What the body must NOT contain:

- **Any character's appearance/styling**: face shape, hairstyle, features, build, clothing, accessories, wear-and-tear — none of it
- **The `styling`/`appearance` source strings**: never copied into the body
- **Re-statements**: the second time a character appears in the same segment, write only `@name` — no features again

**Sole exception — appearance changes that happen in this segment**: soaked clothes, oil on the face, a change of clothes, an injury, a mask — states that differ from the card **must be written in the body** (the card and the lock only carry the unchanging baseline; change can only be expressed in the body). Once a change happens, later segments carry the changed state forward.

**Mandatory final self-check**: scan the body before saving — **none of the characters' appearance/styling source strings may appear** (if one does, it was not slimmed; delete it); then confirm every character appearing has `@name` and the header order matches the reference-image order.

## Paper / certificate props (when they appear in the video)

- **🔴 Never write the paper's text content** (decided 2026-10-09, supersedes the old rule "carry the full surface text"): whatever is printed on the prop is **decided entirely by the reference image** — the prop's `final_prompt` is the finalized image-generation prompt, so the text on the reference is already final. Repeating it in the video prompt always contradicts the reference, and measured wrong every time: 2026-10-09, the registration form's `final_prompt` says `单位：红星机械厂二车间` and `1979年3月17日` across **2 body lines**, while the prompt wrote `第二车间` and `三月十七日` plus a nonexistent extra line `钳工学徒` (**3 lines**).
- **Correct way**: state only the carrier and the action, **never the content** — `her gaze down on the form`, `the printed side turned toward her and away from the lens`, `the printed side of the single form` (mention "the printed side" only, **never what is printed on it**). The old example `the sheet reads "报到证" in large vertical type; three body lines reading "林巧", "红星机械厂", "二车间钳工"` **is VOID — never write it again**.
- **The back must be a blank sheet** (this line stays — it is not text content, it is anti-artifact): state "the paper is opaque; the back is a blank paper back, showing no bleed-through of the front's text, table lines or seal" — especially when the paper is turned, flipped, shown from the back, or held to the light. Otherwise the model shows the front's text through the paper (measured artifact: the registration form's content was visible from the back)
- Never write "the paper is thin / translucent / shows through"

## Pre-submit self-check: three items, beat by beat (hard)

After writing the body, **walk through it one beat (one time range) at a time** — not once for the whole segment:

- [ ] **Every beat carries an audio declaration**: either dialogue/narration (`Narration: …` / `X says: "…"`), or the explicit line "no human voice in this segment, only … ambience". **A beat with neither = the model improvises**
- [ ] **No dialogue/narration within the first 2s or the last 2s**; for segment 2 of a chain, **beat 1 is the hold only** (carry the previous framing + a breath/weight-shift/eyeline micro-motion), dialogue starts at beat 2
- [ ] **Total spoken characters ≤ (segment seconds − 4) × 4.5** (≤27 for a 10s segment, ≤25 recommended)

**Measured failure (do not repeat)**:

```
0-3s: …hand close-up… Narration: "these hands came back with me."
3-6s: …no human voice in this segment, only distant wind and workshop hum…
6-9s: cut to a medium shot, …clenches a fist…   ← no audio declaration at all → the model improvised speech here (bleeding into the next beat)
9-10s: …no human voice in this segment, only footsteps…
```

**Fix**: move the narration out of the first 2s (0-2s = picture + "no human voice…", narration at 2-5s) and give 6-9s its own declaration ("no human voice in this segment, only the knuckle crack and distant workshop hum") — **every beat declares**.

## Chain Carry-Over (never hand-written; the runner adds it)

From segment 2 on, the **runner automatically prepends the airlock head** (hold the previous segment's closing framing for ~2s, no dialogue, a breath/weight-shift/eyeline micro-motion, then cut to the new setup). So, in the text:

- **Never write a carry-over line**: no "continuing from the previous segment's closing framing", no "picking up from the last shot", and do not reuse the previous segment's last word/phrase as the first line — the auto-prepended airlock already does this
- **The first time segment must carry over the previous segment's closing framing** (same camera position, shot size, and number/placement of people), with micro-motion only; **put any camera/shot-size change or change in the number of people after the second time segment** — this is the fix for the union warning
- **Never describe both the old and the new framing in one segment**: the model renders contradictions as **unions** (previous segment ends on a close-up of A, this segment says "a two-shot of B and C" — you get all three). On a scene or subject change, leave the first time segment to the airlock hold (old framing, no dialogue) and write the new scene/framing from the second time segment on
- **The hold carries no dialogue**: put dialogue after the cut to the new setup
- **Leave the tail silent (1.5–2s)**: the chain pins the **previous segment's closing audio** into the next segment's head, so if the previous segment ends mid-speech the next head comes back as garbled speech (measured: correlation between seg2's first 1.2s and seg1's last 1.2s was only 0.045 — new, garbled speech). Finish dialogue/narration 1.5–2s before the end and leave the tail to action and ambience.
- **Spell out silence**: a beat without dialogue/narration must state "**no human voice in this segment, only … ambience**", otherwise H3 invents speech in quiet shots (official guide: write the audio fields explicitly and regenerate; the relay already adds overall_soundscape, but the body should say it too)
- **Dialogue window (every segment, single re-shoots included)**: write **no dialogue/narration in the first 2s or the last 2s** — the chain pins the previous segment's closing audio into this segment's head, so a half-finished previous tail plus a new line at this segment's head fight each other and sound like garbled speech (measured; continuous sound such as counting or drumming chains cleanly because the next segment continues the same activity). **A 10s segment has only ~6s of dialogue window.**
- **Dialogue budget (hard number)**: total spoken characters per segment ≤ **(segment seconds − 4) × 4.5** (≈27 for 10s, **≤25 recommended**). Measured speaking rate 5–6 characters/second — seg1 carried 40 characters of narration and its audio ran to 9.9s, filling the tail. Over budget → cut information or show it visually; "the last beat has no dialogue" does not count, because the earlier line reads through the ending
- About 0.9s of the head is trimmed on delivery, so beats shift earlier; write timecodes against the sampled timing and do not offset by hand (just be aware of the shift)

## Timeline Rules

- Number of segments = storyboard-segment duration ÷ 3 seconds (rounded up); the segment time ranges must add up exactly to the total segment duration
- Content pacing: the first segment establishes → middle segments advance the action/conflict → the final segment lands on the result or emotional beat

## Prohibitions

- Cross-scene switching, flashbacks (a segment takes place in a single scene only)
- Referencing scene/character names outside the lists
- Abstract psychological description, literary metaphor (the model only recognizes visible imagery)
- Language that does not match the session language directive

## Saving

Call `update_storyboard` to update only this storyboard segment's `video_prompt` field; do not modify any other field, and do not re-breakdown the whole episode.

## English send version (official H3 Ref2VA six sections + leading CAST/BLOCKING) — established 2026-10-09

`video_prompt_en` is **the version actually sent to the video model**. Its rules come from the official MiniMax H3 prompt-writing guide (Ref2VA full-reference rewrite output format). **Everything is English except dialogue, lyrics, and text visible in frame.**

**🔴 Length budget (hard, established 2026-10-09): the whole `video_prompt_en` must be ≤ 6200 characters** (run `len()` over it before saving).
The MiniMax H3 prompt limit is **7000 characters — an official hard limit that cannot be relaxed** (RunDiffusion / AtlasCloud / MiniMax official GitHub all state this), and the backend prepends a photorealistic style header before sending, so headroom is mandatory.
**Going over means the request is rejected outright and no video is produced** (measured 2026-10-09: sb147 reached 7608 characters → 8403 after concatenation → error "prompt too long: MiniMax H3 limit 7000 characters, current 8403").

Per-section quotas (allocate to these; count each section when done):
- `CAST:` ≤ 320
- `BLOCKING:` ≤ 560
- `subject_definitions` ≤ 1700 (holds even for multi-character segments)
- `summary` ≤ 340 (the official only asks for one short English paragraph)
- `retention_analysis` ≤ 760
- `detailed_description` ≤ 1900 (official 350–500 words; take the low end)
- `overall_soundscape` ≤ 300
- `non_diegetic_music` ≤ 40
- total ≤ 5920 (the hard cap for the whole prompt stays 6200)

**When over budget, cut in this order**: ① redundant clauses in `summary` ② `soundscape` effects already stated in the body ③ description in `BLOCKING` that duplicates the body ④ appearance modifiers in `subject_definitions`.
**Never cut**: `<d>` dialogue, any `fully_preserved` line in `retention_analysis`, `<Picture N>` and the `with` clause, the count lock in `CAST`, the orientation and 180-axis in `BLOCKING`.

Six section names, fixed order:

```
subject_definitions:
summary:
retention_analysis:
detailed_description:
overall_soundscape:
non_diegetic_music:
```

1. **`subject_definitions`** — one line per tracked subject, **always `<Subject N> is the <category> in <Picture N>, with <appearance features>`**
   - Official example: `<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.`
   - **🔴 `<Picture N>` comes from the `reference_order` table returned by `read_storyboard_context`, copied row by row (established 2026-10-10 after a measured incident)**: this pipeline's reference order is fixed as **scene = image 1 → characters (id ascending) → props last** (same index as `@图片N` and the slot `mod_N`).
  - **How**: **read that storyboard's `reference_order` first**; each row's `picture` is the index, `name` is the asset — copy it **row by row**
  - **Never number by "whoever appears or speaks first"** — measured 2026-10-10: in sb148's 0-5s the male worker appears first, the LLM wrote him as `<Picture 2>` (actually Lin Qiao) and Lin Qiao as `<Picture 3>` (actually the male worker) — **the two reference images were fully swapped** → two copies of the male worker, identities scrambled
  - A shifted index also binds `<Subject N>` to the wrong `mod_N` card (the scene card becomes the identity card = the face drifts)
   - **The scene also needs its own `<Subject N>`**: `<Subject 1> is the scene in <Picture 1>, with ...`. Omitting the scene means it takes neither card nor reference image
   - After `with`, **name the visible appearance item by item**: face shape / hairstyle (length + colour) / garment style and colour / accessories / notable wear. **Source it from the asset's `appearance`/`styling`/`description`/`prompt`/`location` fields rewritten into English — never omit, never invent**
   - **An image that only defines a subject and never acts as a frame anchor gets no standalone `<Picture N>` line** — cite it inside the `<Subject N>` definition (official: *If an image is used only to define a character, scene, costume, or style, do not create a standalone picture entry.*)
   - **🔴 When the reference is a MULTI-VIEW SHEET, the `<Subject N>` definition must name the views (established 2026-10-09)**:
     - **How to tell**: look **only at the asset's `final_prompt` / `prompt` (the finalized image prompt)** — if it says the image is a multi-view sheet (`三联参考板` / `三视图板` / `四格板` / `character sheet` / `multiple views` / `shown from N angles`). **Deliberately NOT `description`** — that field is the item's physical appearance and must never carry layout/panel information (measured 2026-10-09: writing "left large panel / top-right panel" into `description` polluted the appearance field and had to be rolled back). **If it does not say so, treat it as a single view — never guess.**
     - **Why it is mandatory**: when the sheet shows **both front and back**, not saying so makes the model treat them as **several different things** → the prop duplicates into two sheets (one measured root cause, 2026-10-09).
     - **How to write it (prop three-view sheet)**: `<Subject 3> is the registration form shown from three angles in <Picture 3>: a top-down view of its printed front, a three-quarter view of the same sheet, and its blank back — one single sheet seen three ways, not two or three separate forms.`
     - **A character's four-panel sheet may stay unwritten** (the model already reads front/side/back of a person), but **props — and anything with a front and a back — must be written out**.
     - **`retention_analysis` in sync**: append `stays identical from every angle shown in <Picture 3>; one single sheet, never duplicated.`
   - **Write `cloth shoes`, never `liberation shoes`** — the literal translation renders as odd boots
   - **A prop needs at least one "clear full-view" shot, but get it through the CAMERA ANGLE, never by having the character hold it up (final wording after three rounds of measurement, 2026-10-09)**:
     - **Why it is needed**: if a `<Subject N>` is only ever "clutched in hand / folded away / tucked into a pocket", there is nothing in frame to lock and the model invents it → the prop is always lost.
     - **🔴 How: NEVER write `facing the camera` / `toward the camera` / `presented to the viewer`** — those words make the model turn the prop or a body part **squarely toward the audience**, so the finished clip shows the character holding the form up for the viewer, which reads as terrible acting (reproduced 2026-10-09; the user explicitly rejected it).
     - **🔴🔴 Also BAN the "overhead + lying flat" combination (third round of measurement, 2026-10-09 — geometrically inevitable)**: a line like `settles high above them, looking down at the form lying open in her palms` puts the camera straight above while the paper lies flat in the palm, so **the paper's face is necessarily square to the lens**, and the text at the top of the sheet reads **upside down** from the camera's point of view — the finished clip is the character holding it out to the audience upside down. **Overhead is not the fix; it is a new trap.**
     - **✅ Correct posture (all three at once)**:
       ① **Camera off to the side / three-quarter, not straight above**: `the camera at a low three-quarter angle beside her hands`, `over her shoulder, from her side`
       ② **The printed side of the prop faces the character, away from the lens**: `the printed side turned toward her, away from the lens`, `the text facing her, the blank back toward the camera`
       ③ **The prop keeps a perspective angle — never flat and square**: `the form held at an angle in her hands`; ban `lying flat` / `lying open` / `flat against her palms`
     - **🔴 Lock the prop's QUANTITY explicitly (it otherwise duplicates into two sheets)**: write it at least once in the body — `a single sheet, exactly one form in her hands, never duplicated` — and add `only one form, never duplicated` to `retention_analysis`. **Writing `single` only in `subject_definitions` is not enough**: measured 2026-10-09, the definition said `a single white paper slip` and the second half of the clip still showed two sheets pressed together (`lying open` got drawn as a spread of multiple sheets)
     - **🔴 Never invent a shot**: if the storyboard description does not contain that prop shot, do not add one (measured 2026-10-09: beat 1 of storyboard 146 contained only a palm, and the LLM added the form lying flat toward the camera).
     - **Banned (all of them)**: `the form lying flat and fully visible facing the camera` ❌ / `settles high above them, looking down at the form lying open in her palms` ❌
     - **Correct**: `the camera at a low three-quarter angle beside her hands, the printed side of the single form turned toward her and away from the lens, held at an angle, her gaze down on the paper` ✅
   - With a voice card, add one `<Audio 1>` line. **The voice card is a timbre reference; off-screen narration has no separate audio source, so the narrator MUST be designated as one of the on-screen characters** (usually the protagonist herself):
     - Segment has **off-screen narration** → `<Audio 1> is the voice-timbre reference for <Subject N>'s off-screen narration (S1); use it only as a timbre reference and do not reproduce its words.` (binds **that character's narration timbre**, not "the mouth speaking on screen")
     - Segment is **entirely on-screen dialogue with no narration** → `<Audio 1> is the voice-timbre reference for <Subject N> (S1).`
2. **`summary`** — one English paragraph **opening with a bracketed task type**; this pipeline always uses `[reference generation]` (references guide generation without serving as a first frame/keyframe and without being an edited or continued source video). Official types: `keyframe completion` / `reference generation` / `video editing` / `video continuation` / `audio reuse` / `audio reference`; combine with ` + `
3. **`retention_analysis`** — one line per label; markers only `fully_preserved` / `partially_preserved` / `attribute_transfer` / `weak_reference`
   - `<Audio N>` uses `reference`:
     - With off-screen narration: `<Audio 1>: reference - its vocal timbre guides <Subject N>'s off-screen narration without copying the original signal.`
     - With on-screen dialogue only: `<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject N> without copying the original signal.`
   - **Never write speaker IDs like `(S1)` here** (official: *Do not write `(Sx)` in `retention_analysis`.*)
4. **`detailed_description`** — the body
   - **`[Shot 1]` carries no timestamp**; later shots use `[Shot 2] At 00:06.000, ...`
   - **🔴 CAST + BLOCKING (established 2026-10-09; same day, per user decision, promoted from inside `detailed_description` to a top-level section)**: put it at the very top of the whole prompt, **before `subject_definitions`**, as its own section above the official six. **The official six sections keep their exact field names and order** (`subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`); CAST/BLOCKING is only added ahead of them — no renaming, no displacement, no reordering. **The old rule "Do NOT add a new top-level section" is VOID as of 2026-10-09**: that was an absolute wording I added myself; the official only says preserve field names and order (official skill wording: *Preserve the exact field names, section order, labels, and timing notation*) and never issued a prohibition — the official guide in fact requires position / subject placement per shot, it just does not give this content a section name. **⚠️ Unmeasured risk (must verify after generation)**: if H3's parser strictly splits on the official six sections, this leading section may be ignored or may error — check the first run to confirm H3 actually consumes it.
     - **CAST (fixes duplicated faces / the prop duplicating into two sheets)**: name how many people and how many props are in this segment, then lock the count and forbid repetition:
       `CAST: exactly one young woman, one registration form, one factory gate; no twins, no duplicated figures, no extra people, no second copy of the form, no duplicated wardrobe.`
  - **🔴 Two characters of the same trade MUST carry a "distinction lock" (measured 2026-10-10: storyboard 4's 0-5s turned the "bystander worker" into a second Zhang Jianguo)**: when two characters of the **same gender, same age band, same trade** appear in one segment (e.g. two middle-aged male workers), the count lock alone is **not enough** - add a **distinction lock** to CAST and give each one its own look:
    `two different men, visually distinct - one in a grey-blue work shirt with no gloves, the other in a dark-blue jacket with grey cotton gloves; they must not share the same face.`
    - Each same-trade character's `<Subject N>` must carry **at least 2 identifying traits the other lacks** (gloves or not, jacket colour, apron material, beard, hat, build, hairstyle)
    - When BLOCKING names the two, **attach each one's unique trait** (so the model does not merge them into one person)
    - **The real fix is the reference image**: when the two reference boards are themselves low-contrast, the prompt only mitigates - fully separating them requires redoing the reference images with unique traits
  - **🔴 Never write a character's real name in CAST/BLOCKING/body (established 2026-10-09)**: use only appearance references like `one male worker` / `the round-faced worker`, **never a name like `Zhang Jianguo`** - names get treated as extra subjects and can raise copyright issues
       **Far stronger than writing `single` in `subject_definitions`** — measured 2026-10-09: the definition said `a single white paper slip` and the second half of the clip still showed two sheets pressed together.
     - **BLOCKING (fixes drifting positions / wrong orientation / the prop held upside down)**: fix who stands where, which way the prop faces, which side the camera is on, and **where the axis is**:
       `BLOCKING: the woman stands centre-frame, the factory gate behind her; the form held in both hands at waist height, its printed side turned toward her and away from the lens. The camera stays on her side of the hands; the 180 axis runs through her hands and is never crossed.`
       **The 180 axis is a century-old film rule**: once the camera crosses the line, the audience loses track of orientation and prop direction flips — the 2026-10-09 "registration form held out upside down to the viewer" was exactly this, no axis constraint letting each beat pick a camera side freely.
     - **Reference structure (higgsfield's proven example, verbatim shape)**: `BLOCKING: Fire foreground center, x50 y74, blurred. Group in a semicircle beyond it, 1.5 m from flames. Camera stays on one side of the fire; the 180 axis runs through the fire and is never crossed. P3 and P4 stay screen-left looking camera-right.`
     - **⚠️ But do not copy the pixel coordinates**: H3 is not Veo, so `x50 y74`-style coordinates do nothing for H3. H3 wants **relative positions described in words**: `centre-frame` / `screen-left looking camera-right` / `behind her` / `at waist height` / `1.5 m from her`.
   - **The style sentence goes BEFORE `[Shot 1]` as one or two standalone sentences** (T2VA puts it after Shot 1; Ref2VA puts it before — an official difference)
   - At a subject's **first clear appearance**, describe its features, position in frame, and current action; later shots reuse the same `<Subject N>` **without redefining it**
   - **There is only ONE allowed speaker form** (established 2026-10-09; supersedes every earlier form):
     - **On-screen dialogue** (that shot must actually have the subject present and speaking): `<Subject 2> (S1) says, <d>[Chinese] line</d>`
     - **Off-screen narration / voice-over**: `<Subject 2>'s voice-over (S1) speaks off-screen while on screen her lips stay completely closed and her mouth does not move: <d>[Chinese] line</d>`
     - **The narrator MUST be designated as one of the on-screen characters** (usually the protagonist herself) — off-screen narration has no independent audio source, so leaving the narrator unspecified means the model invents a voice
     - **🔴 These two forms are BANNED** (both make the model attach the speaking action to the on-screen figure, causing a moving mouth / a duplicated character): ① `<Subject 2> (S1) says off-screen` ② `A young woman's low restrained voice (S1) speaks off-screen` (voice-description form = narrator never designated; reproduced 2026-10-09)
   - **🔴 The lip lock must share the sentence with the dialogue** (no action description in between): the official example literally reads `She closes her lips`. The lip lock must sit **directly against the `<d>` block**, with no action or frame description inserted (measured 2026-10-09: lip lock at start of beat, dialogue at end, three action clauses in between → the mouth still moved)
   - **🔴🔴 A beat carrying off-screen narration MUST NOT show the speaker's face (hard rule; it overrides every lip-lock wording above)**:
     - **Why**: video models carry a strong prior — *a face on screen + a line of dialogue = that person is speaking*. A lip lock is a text constraint and **cannot beat that prior**. Measured 2026-10-09: lip lock sharing the sentence, voice-over bound to the designated character, and the voice card bound to the narration timbre — all three done correctly — and she still mouthed the line at 5–9s. **The only fix is to remove the face**: with no visual anchor for "who is speaking", the model treats it as a voice-over.
     - **Only these three camera setups are allowed on a narration beat**: ① **hands-only close-up** (hands + prop only, `extreme close-up of her hands holding the form`) ② **back of head / over the shoulder** (`from behind, the back of her head`, `over her shoulder`) ③ **insert shot** (scene or prop alone, `the form lies open on the workbench`)
     - **🔴 Banned**: any framing that puts her face in frame on a narration beat (`close-up of her face`, `high-angle close-up: <Subject 2> lowers her head` — anything where the face is visible)
     - **This project established this rule on 2026-10-08** ("no beat covered by off-screen narration may show the character's face"), **it was lost during the bilingual rewrite**, reproduced 2026-10-09 → restored now
   - **`retention_analysis` never contains `(Sx)`** (speaker numbers appear only in `detailed_description`)
   - Dialogue only as `<d>[Chinese] original line</d>`, **copied verbatim from the storyboard description — never paraphrase or invent**
   - **🔴 Drop whole sentences only — never truncate or reword (measured 2026-10-09)**: cutting one line into two, or deleting half of it, silently swallows plot (measured: `撞见了张建国` vanished entirely). If it does not fit, **drop the whole sentence**; every dropped sentence must be **explicitly marked in the Chinese working version** (e.g. `（本段未采用：XX句——原因：10秒装不下）`) so the user can see it
   - Text visible in frame keeps its original Chinese
   - Generation bodies run **350-500 English words**
5. **`overall_soundscape`** — ambience (English); shots without dialogue state no human voice: `(No human voice in this segment except the dialogue lines explicitly written below; no narration, no humming, no singing.)`
6. **`non_diegetic_music`** — score audible only to the audience; `N/A` when absent

**Self-check before saving**: `CAST:` and `BLOCKING:` both present **before `subject_definitions`** (top of the whole prompt) and complete / official six section names present and in order / **prop surface text content absent** (only `the printed side` / carrier + action phrasing appears — **no** quoted paper text anywhere) / every `subject_definitions` line has `<Picture N>` plus a `with` clause / `retention_analysis` contains no `(Sx)` / all dialogue copied **as whole sentences** verbatim from the description (no truncation, no rewording; dropped sentences marked) / narrator designated as one of the on-screen characters and the voice card written as `<Subject N>'s off-screen narration` / lip lock sitting immediately next to the `<d>` line (not separated by action) / `Same exposure...` appears once in the style sentence only (not repeated per shot) / body is English except `<d>` and on-screen text
