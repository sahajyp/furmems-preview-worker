// FurMems Co. portrait styles: one AI prompt per style.
// The ids must match the STYLES list in the website's index.html.
// To change the seasonal style (Halloween -> Christmas), edit the "halloween" entry here
// and the matching entry in index.html, then run `npx wrangler deploy`.

const KEEP_PET =
  "Keep it unmistakably the same animal: same species and breed, same fur colors and markings, " +
  "same eye color, ear shape and face shape. No text, no lettering, no signature, no frame, no border, no people.";

// Added for the website previews and samples, which are vertical portraits
export const PREVIEW_COMPOSITION = "Vertical portrait composition with the pet centered, head and shoulders.";

export const STYLES = {
  pastel: {
    name: "Pastel painting",
    prompt:
      "Repaint the pet in this photo as a soft pastel painting portrait. Chalky soft-pastel texture with gently " +
      "blended strokes, light and airy, a palette of blush pink, lavender, cream and powder blue, with a soft, " +
      "simple pastel background. " + KEEP_PET,
  },
  watercolor: {
    name: "Watercolor",
    prompt:
      "Repaint the pet in this photo as a delicate watercolor portrait. Loose, flowing washes with soft bleeding " +
      "edges, visible watercolor paper texture, light pastel tones and plenty of white space around the pet. " + KEEP_PET,
  },
  oil: {
    name: "Oil paint",
    prompt:
      "Repaint the pet in this photo as a classic oil painting portrait. Rich, visible brushstrokes, soft studio " +
      "lighting, warm depth, and a muted pastel-toned painted background, like a fine-art commission. " + KEEP_PET,
  },
  halloween: {
    name: "Halloween cartoon",
    seasonal: true,
    prompt:
      "Redraw the pet in this photo as a cute Halloween cartoon illustration. Bold clean outlines, flat bright colors, " +
      "the pet wearing a small witch hat, with smiling jack-o'-lanterns, little bats and a big autumn moon behind it, " +
      "in an orange, purple and soft cream palette. Spooky-cute and friendly, never scary. " + KEEP_PET,
  },
};
