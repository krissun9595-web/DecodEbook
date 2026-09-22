// Shared style options for generative modules (VISUAL_CORE images + CINE_RENDER video).
// Single source of truth so the two dropdowns stay unified. Each entry is both a
// prompt modifier and part of the generation cache key, so treat these strings as stable.
export const GEN_STYLES = [
  'Digital Art', 'Cinematic', 'Anime', 'Photorealistic', 'Cartoon', 'Sketch',
  'Cyberpunk', 'Vaporwave', 'Neon', 'Line Art', 'Low Poly', 'Isometric',
  '3D Render', 'Pixel Art', 'Noir', 'Documentary', 'Surreal',
];
