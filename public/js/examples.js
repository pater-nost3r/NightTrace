// Built-in examples. Each points to a prepared manifest of real SPHEREx frames
// (public/data/examples/<manifest>/) and picks frames A and B by observation id.
export const EXAMPLES = [
  { id: "cats-eye", manifest: "cats-eye", a: "2025W18_1B_0065_1", b: "2026W10_1A_0309_1", mode: "swipe", zoom: 4 },
  { id: "false-change", manifest: "cats-eye", a: "2026W01_1A_0076_1", b: "2026W01_1A_0631_1", mode: "swipe", zoom: 5, onboarding: true },
  { id: "same-visit", manifest: "cats-eye", a: "2025W18_1B_0065_1", b: "2025W18_1B_0065_2", mode: "blink", zoom: 2 },
  { id: "orion", manifest: "orion", a: "first", b: "last", mode: "swipe" },
  { id: "pluto", manifest: "pluto", a: "2026W17_2A_0387_1", b: "2026W18_1A_0198_1", mode: "blink", zoom: 6 },
];
// Shown in the list as an honest gap, not as a button (none at the moment).
export const UNAVAILABLE = [];
export const MANIFESTS = { "cats-eye": { ra: 269.6392, dec: 66.6331 }, orion: { ra: 83.822, dec: -5.391 }, pluto: { ra: 308.526, dec: -22.892 } };
export const MAP_PLACES = [
  { ex: "cats-eye", ra: 269.6392, dec: 66.6331, ru: "Кошачий глаз", en: "Cat’s Eye" },
  { ex: "orion", ra: 83.822, dec: -5.391, ru: "Орион", en: "Orion" },
  { ex: "pluto", ra: 308.526, dec: -22.892, ru: "Плутон (апр. 2026)", en: "Pluto (Apr 2026)", side: "left", dy: -8 },
  { ra: 266.4051, dec: -28.9362, ru: "Центр Галактики", en: "Galactic centre", side: "right", dy: 6 },
  { ra: 10.6847, dec: 41.269, ru: "Андромеда", en: "Andromeda" },
  { ra: 80.8942, dec: -69.7561, ru: "Тарантул (БМО)", en: "Tarantula (LMC)" },
];
