// Vignette: screen-space radial falloff toward the frame corners.
export default {
  id: 'vignette', label: 'Vignette', icon: '◐',
  amount: 'vignette',
  params: [
    { key: 'vignette', label: 'Amount', min: 0, max: 1, step: 0.01, def: 0, add: 0.55 },
    { key: 'vignetteSize', label: 'Size', min: 0.2, max: 1.2, step: 0.01, def: 0.7 },
    { key: 'vignetteFeather', label: 'Feather', min: 0.05, max: 1, step: 0.01, def: 0.5 },
  ],
};
