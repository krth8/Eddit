// Wiggle: rigid smooth-noise position jitter of the whole layer.
export default {
  id: 'wiggle', label: 'Wiggle', icon: '〰',
  amount: 'wiggle',
  params: [
    { key: 'wiggle', label: 'Amount', min: 0, max: 1, step: 0.01, def: 0, add: 0.3 },
    { key: 'wiggleFreq', label: 'Speed', min: 0, max: 1, step: 0.01, def: 0.5 },
  ],
};
