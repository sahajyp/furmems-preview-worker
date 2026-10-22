// FurMems Co. portrait styles.
// ONE prompt per style, used word-for-word everywhere: website previews (OpenAI),
// sample pets (make-samples) and print files (make-print, OpenAI or FLUX.2 Pro).
// Always build prompts with buildPrompt(styleId) so they never drift apart.
//
// The ids must match the STYLES list in the website's index.html.
// To change the seasonal style (Halloween -> Christmas), edit the "halloween" entry here
// and the matching entry in index.html, then run `npx wrangler deploy`.

// Likeness: applies to every style
const KEEP_PETS =
  "Keep every animal from the photo, and keep each one unmistakably itself: same species and breed, " +
  "same fur colors and markings, same eye color, same ear shape and ear position, same face shape. " +
  "Do not add or remove any animals.";

// Composition: every artwork is a 2:3 vertical portrait that shows the whole pet with room to spare,
// so it can be placed on canvases, mugs, blankets and ornaments without cutting anything off
const COMPOSITION =
  "Vertical portrait composition with the pet centered. Show the pet's entire head including the full " +
  "tips of both ears, plus the neck and chest; nothing important may touch or be cut off by the edges. " +
  "Leave generous empty background on all four sides, especially above the ears.";

const CLEAN = "No text, no lettering, no signature, no frame, no border, no people.";

export const STYLES = {
  pastel: {
    name: "Pastel painting",
    style:
      "Repaint the photo as a soft pastel painting portrait. Chalky soft-pastel texture with gently blended " +
      "strokes, light and airy, a palette of blush pink, lavender, cream and powder blue, with a soft, simple " +
      "pastel background.",
  },
  watercolor: {
    name: "Watercolor",
    style:
      "Repaint the photo as a delicate watercolor portrait. Loose, flowing washes with soft bleeding edges, " +
      "visible watercolor paper texture, light pastel tones and plenty of white space around the pet.",
  },
  oil: {
    name: "Oil paint",
    style:
      "Repaint the photo as a classic oil painting portrait. Rich, visible brushstrokes, soft studio lighting, " +
      "warm depth, and a muted pastel-toned painted background, like a fine-art commission.",
  },
  halloween: {
    name: "Halloween cartoon",
    seasonal: true,
    style:
      "Redraw the photo as a cute Halloween cartoon illustration. Bold clean outlines, flat bright colors, " +
      "smiling jack-o'-lanterns, little bats and a big autumn moon in the background, in an orange, purple and " +
      "soft cream palette. Spooky-cute and friendly, never scary. " +
      // The hat: exactly one, on one animal, and it must never overlap the ears
      "Add exactly ONE small witch hat in the whole picture. Only one animal wears it: the animal whose head is " +
      "highest in the picture. Every other animal wears no hat at all. The hat is small and sits on top of the head, " +
      "fitting in the space between the ears, tilted slightly to one side. Both ears stay complete, fully visible " +
      "and in front of the hat, standing exactly as in the photo. The hat never covers, overlaps, cuts into or " +
      "passes through an ear. If there is not enough room between the ears, make the hat smaller and place it " +
      "further back on the head rather than touching the ears.",
  },
};

export function buildPrompt(styleId) {
  const s = STYLES[styleId];
  if (!s) throw new Error(`Unknown style "${styleId}"`);
  return `${s.style} ${KEEP_PETS} ${COMPOSITION} ${CLEAN}`;
}
