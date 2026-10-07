---
name: video-prompt
description: Video prompt specification — generates a time-segmented video-generation prompt from storyboard-segment content, with cuts allowed within a segment
---

# Video Prompt (storyboard segment → video_prompt)

From a single storyboard segment's description (containing the 【镜头N】 sub-shot structure and dialogue/narration) / atmosphere / duration, generate the `video_prompt` that drives AI video generation. **One storyboard segment = one 8-15-second video, with cuts allowed inside it**: consecutive segments may be different shots (change of shot size/angle/subject), joined with hard cuts; but the whole segment **never crosses scenes** and never uses flashbacks.

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
- **Dialogue/narration**: write "CharacterName says: "line""; narration as "Narration: content"; a long line that cannot be spoken within 3 seconds is split across multiple segments; a segment without dialogue may note ambient/action sounds (e.g. "machines keep roaring")

## Reference Rules

- `@SceneName` — scene reference; the name must exactly match the location in the scene list
- `@CharacterName` — character reference; the name must exactly match the name in the character list
- `@PropName` — prop reference; the name must exactly match the name in the prop list; reference a prop when it is clearly visible in frame, used, or shown in close-up
- During generation, each `@name` is automatically replaced with the corresponding reference-image marker (e.g. `@Xiaoming` → `@Image1Xiaoming`), so names must match exactly — do not abbreviate or add extra symbols
- **Every segment must have at least one @ reference anchoring the frame**; any segment in which a character appears must @ that character; only reference scenes/characters/props already bound to this storyboard segment
- **Multi-character segments must declare each character separately**: write every character's own `@name` in the header, and make sure each character appearing in the body also gets `@name` at least once — **the name only, never a description**. The relay builds one `<Subject N>` identity per entity, which is what stops the reference images and cards from contaminating each other. Without it the model **averages several faces into one new face**.
- **Point each shot at the panel of the character board** (once, on a character's first appearance): `@LinQiao (this shot uses 脸部特写格)`. The board has **four panels** (left to right: face close-up / front full body / 90° left side full body / back full body — all three views **keep the head**); copy the panel name **verbatim** from: `脸部特写格` / `正面全身格` / `90度左侧面全身格` / `背面全身格` (close-up → face panel, full-body/medium → front full-body panel). **Never invent a panel**, **never name two panels at once**, never reword a panel name
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
- The `same exposure, same white balance, no new light source` lock; cuts

What the body must NOT contain:

- **Any character's appearance/styling**: face shape, hairstyle, features, build, clothing, accessories, wear-and-tear — none of it
- **The `styling`/`appearance` source strings**: never copied into the body
- **Re-statements**: the second time a character appears in the same segment, write only `@name` — no features again

**Sole exception — appearance changes that happen in this segment**: soaked clothes, oil on the face, a change of clothes, an injury, a mask — states that differ from the card **must be written in the body** (the card and the lock only carry the unchanging baseline; change can only be expressed in the body). Once a change happens, later segments carry the changed state forward.

**Mandatory final self-check**: scan the body before saving — **none of the characters' appearance/styling source strings may appear** (if one does, it was not slimmed; delete it); then confirm every character appearing has `@name` and the header order matches the reference-image order.

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
