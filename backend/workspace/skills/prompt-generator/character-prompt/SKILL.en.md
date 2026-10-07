---
name: character-prompt
description: Character reference board spec — four panels in one frame, left to right: face close-up / front full body / 90-degree left side full body / back full body (all three views keep the head). Side view is always the left side; the face close-up sits leftmost
---

# Character Reference Board (four panels: face close-up / front / left side / back — three views with heads)

The output is one character reference board: **a single frame containing four vertical panels, arranged left to right**, each panel with exactly one job:

- **Panel 1: face close-up (leftmost)** — frontal ID-photo framing above the chest; **this is the identity anchor of the whole board**
- **Panel 2: front full body (with head)** — standing front view, head facing the camera; shows face, hairstyle, the full outfit and build
- **Panel 3: 90-degree left side full body (with head)** — nose pointing to the left of frame; checks the side silhouette, hair length and side-body shape
- **Panel 4: back full body (with head)** — standing back view; checks the back of the head/hairstyle, the back of the outfit and posture

**Why this split**: identity is locked by the **RefMod card** (extracted from this board) together with the "face close-up panel" — **headless panels are no longer needed to prevent face mixing**. All three views keep their heads so that build, hairstyle (including side and back length/shape) and clothing all enter the card — measured: **extracting from the whole board works clearly better than feeding only the face crop**. The face close-up sits leftmost so the identity anchor comes first.

**Core principle: consistency > beauty.** This image is the appearance anchor for all later character images and video references; it must be neutral, clear and reusable — do not chase the artistry of a single image.

## Output Structure (assemble one coherent passage in this order; language follows the session language directive)

```
Character reference board: a single frame with four vertical panels left to right, all four showing the same character in the same outfit;
Panel 1 face close-up: frontal ID-photo framing above the chest (equivalent to a 1-inch ID photo), head-to-shoulders only, nothing below the chest, no hands, no full body, everything from the top of the head to the shoulder line in frame; head and neck centred, head facing the camera without tilting, face left-right symmetric, both ears at the same height and both visible, chin level, gaze straight into the lens;
Panel 2 front full body: full-body front view with head, head facing the camera with clearly visible facial features, neutral A-pose, arms hanging naturally, soles of the feet fully in frame;
Panel 3 90-degree left side full body: full-body left profile with head, nose pointing to the left of frame, left facial profile, left ear and left-side hairstyle visible; nearest side shows the left shoulder, left arm and left trouser line; soles of the feet fully in frame;
Panel 4 back full body: full-body back view with head, back of the head and the complete rear hairstyle visible (length, shape of the ends), back of the outfit and posture clear, soles of the feet fully in frame;
the four panels are equal in height, side by side and evenly spaced, shoulder lines on one horizontal line and soles on one horizontal line;
[age impression + gender impression + physique], [facial features], [hairstyle], [clothing + accessories];
the collar visible at the shoulders in panel 1, its fabric colour and style, is the same garment as the top in panels 2, 3 and 4 — collar shape, colour, buttons and wear identical; jacket, inner layer, trousers and shoes identical piece by piece;
only this one character appears on the board, all four panels have a head, and the face is taken from panel 1 only;
pure white background, soft even lighting, cinematic quality
```

## Description Order Rules

Put the **most recognizable features first**, covering every key element of `appearance` (looks) and `styling` (hair/clothing/makeup) in this order, with no omissions:

1. Identity anchors: age impression (e.g. "early twenties"), gender impression, physique (height and build, posture habits)
2. Ethnicity lock (first anti-face-mixing rule): for Chinese stories write "East Asian face" plus East Asian features (e.g. single or inner-double eyelid, wide nose bridge, black eyes, yellow skin). Never use "deep-set eyes, high nose bridge, strongly sculpted features" — the model defaults to Western faces and will drift if not locked
3. Facial features: face shape, eyes, other notable features (scars, moles, glasses, etc.) — the face close-up depends on this part especially
4. Hairstyle: colour, length, style (length and the shape of the ends must be checkable in the side and back panels)
5. Clothing: style, colour, material, condition (e.g. "a wrinkled work uniform with solder marks on the cuffs")
6. Accessories: write only the recognizable ones; do not pile them on

Convert the character's personality traits into outward bearing and expression descriptions (e.g. "haggard" → "weary eyes, slightly slumped shoulders"); personality words must not appear directly.

## Composition & Consistency

- **Exactly four panels, fixed order: panel 1 face close-up (leftmost) → panel 2 front full body → panel 3 90-degree left side → panel 4 back full body.** Never reorder, never add or drop a panel
- **The face close-up must be leftmost (panel 1)** — it is the identity anchor; the backend crops it into a standalone face reference and it feeds the RefMod card
- **All three views are present and all keep their heads**: panels 2/3/4 must draw the head (face, hairstyle, ears and back of the head as each view requires). **No headless treatment anymore** — the wording and the effect "headless", "head removed", "cut-off neck" and "mannequin" are forbidden
- **The side panel is always the LEFT side, described with one single directional phrase**: write "**90-degree left profile, nose pointing to the left of frame**". Do **not** also write a second directional phrase such as "shot from the character's left" or "left side turned forward" — with two phrases the model renders a three-quarter turn. List the visible parts instead (nearest side shows the left shoulder, left arm, left trouser line). **A right profile is never allowed**; the direction must be identical every time, or cross-image alignment mirrors
- Panel 1 face close-up: **head to shoulders only** (equivalent to a 1-inch ID photo); **nothing below the chest, no hands, no full body** — if the close-up turns into a full head portrait it fails
- **The face close-up must have the head straight to camera and the neck upright**: write explicitly "head facing the camera without tilting, face left-right symmetric, both ears at the same height, chin level, gaze straight into the lens" — a tilted head breaks the identity anchor and every later video reference tilts with it
- **All four panels must wear the same garment**: collar shape, colour, buttons and fabric wear must match item by item; jacket, inner layer, trousers and shoes identical piece by piece
- **Only this one character may appear**: no second person, no duplicate of the same person
- **Faces are taken from panel 1 only**: when a video prompt references this board and the shot needs the face, name the "**face close-up panel**"; the other three panels supply build, clothing and hairstyle from multiple angles
- Neutral pose, natural expression — so the board stays reusable as a reference
- Soft even studio lighting; no dramatic lighting (the reference must work in any scene)
- Output in the target language required by the session language directive; do not mix in unrelated wording

## Forbidden

- Dynamic poses, exaggerated expressions, holding props, sharing the frame with others
- **Headless / head removed / cut-off neck / mannequin** (the spec requires heads in all three views; any occurrence = fail, regenerate)
- **Tilted head / profile / looking up or down / slanted shoulders / off-centre body** (the face close-up accepts only a straight-to-camera head). At review, if panel 1's head axis deviates more than about 5° from the frame's vertical, it fails and must be regenerated
- **Panel 1 exceeding head-and-shoulders** (anything below the chest, hands, full body = fail, regenerate)
- **Mismatched clothing across the four panels** (different colour/style/collar/buttons = fail, regenerate)
- **A right profile, three-quarter view or half-turn in the side panel** (must be the 90-degree left profile with the nose pointing left; any deviation = fail, regenerate)
- **A fifth panel, collage, repeated sets side by side, or wrong panel order** (exactly four panels, in the order face / front / left side / back)
- Cropping the body (panels 2/3/4 must show the soles of the feet; panel 1 must span the top of the head to the shoulder line)
- Text, labels, watermarks, signatures
- Heavy shadows, coloured background light, background props

## Saving

Call `save_character_final_prompt`: the prompt parameter contains no style words — **the project's visual style is automatically injected by the tool at the very front of the final prompt**.

**Final self-check (mandatory)**: before saving, verify word by word that all six hard constraints are present — ① four panels in one frame, ordered panel 1 face close-up (leftmost) / panel 2 front full body / panel 3 left side full body / panel 4 back full body, no fifth panel; ② the side panel reads "**90-degree left profile, nose pointing to the left of frame**" with no second directional phrase ("shot from the character's left / left side turned forward") and is not a right profile; ③ all three views **keep their heads**, and the prompt contains **none** of "headless / head removed / cut-off neck / mannequin"; ④ the face close-up is bounded: "head to shoulders only, equivalent to a 1-inch ID photo, nothing below the chest, no hands, no full body"; ⑤ the head lock: "head facing the camera without tilting, face left-right symmetric, both ears at the same height, chin level, gaze straight into the lens"; ⑥ clothing consistency: "the collar visible at the shoulders in panel 1, its fabric colour and style, is the same garment as the top in panels 2, 3 and 4". If any part is missing, the spec was not followed — fix it before saving.
