// FurMems Co. products for website previews.
// Each option is one Printify variant: id = variant_id, width/height = print area in pixels.
// The site reads this list from the Worker (GET /products), so edit it here only.
export const PRODUCTS = {
  canvas: {
    label: "Canvas", optionName: "Size", blueprint_id: 1159, print_provider_id: 99, default: 91643,
    options: [
      { id: 91640, name: '9" × 12"',  width: 2700, height: 3600 },
      { id: 91643, name: '12" × 16"', width: 3600, height: 4800 },
      { id: 91648, name: '18" × 24"', width: 5400, height: 7200 },
      { id: 91652, name: '24" × 32"', width: 7200, height: 9600 },
    ],
  },
  mug: {
    label: "Mug", optionName: "Color", blueprint_id: 635, print_provider_id: 99, default: 72183,
    options: [
      { id: 72183,  name: "Pink",        width: 2475, height: 1155 },
      { id: 105888, name: "Light blue",  width: 2475, height: 1155 },
      { id: 108907, name: "Purple",      width: 2475, height: 1155 },
      { id: 113942, name: "Light green", width: 2475, height: 1155 },
    ],
  },
  blanket: {
    label: "Woven blanket", optionName: "Size", blueprint_id: 1626, print_provider_id: 99, default: 112794,
    options: [
      { id: 112794, name: '52" × 37"', width: 4992, height: 3552 },
      { id: 399290, name: '60" × 80"', width: 5760, height: 7680 },
    ],
  },
  ornament: {
    label: "Ornament", optionName: "Shape", blueprint_id: 1632, print_provider_id: 99, default: 112959,
    back: true, // front and back are both printable; the back carries the pet's name
    options: [
      { id: 112959, name: "Round", width: 900, height: 900 },
      { id: 148368, name: "Heart", width: 962, height: 908 },
    ],
  },
};
