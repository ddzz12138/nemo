// A Maps link opens directions. It does not calculate a duration or a live ETA.
const MODES = { driving: 'd', public: 'r' };

export function appleMapsDirections({ origin, destination, mode }) {
  if (!MODES[mode]) throw new Error('Choose driving or public transport.');
  const url = new URL('https://maps.apple.com/');
  url.searchParams.set('saddr', point(origin));
  url.searchParams.set('daddr', point(destination));
  url.searchParams.set('dirflg', MODES[mode]);
  if (url.protocol !== 'https:' || url.hostname !== 'maps.apple.com') throw new Error('Map link was rejected.');
  return url.toString();
}

function point(place) {
  const latitude = Number(place?.latitude);
  const longitude = Number(place?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Map link needs confirmed coordinates.');
  return `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
}
