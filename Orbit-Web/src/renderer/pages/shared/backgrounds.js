// Generated from Orbit OS branding/tokens.json (wallpapers): the same blobs as the desktop wallpapers.
export const BGS = {
 "Glass": "radial-gradient(circle at 18% 62%, #f28dc4cc, transparent 49.5%), radial-gradient(circle at 50% 50%, #9b6cf0cc, transparent 49.5%), radial-gradient(circle at 85% 15%, #5aa6ffcc, transparent 45%), radial-gradient(circle at 30% 15%, #c58cf5cc, transparent 31.5%), #2a1f4a",
 "Lagoon": "radial-gradient(circle at 20% 70%, #2fb9a8cc, transparent 49.5%), radial-gradient(circle at 55% 45%, #0f5a45cc, transparent 54%), radial-gradient(circle at 85% 20%, #2f6fd1cc, transparent 45%), #0b2226",
 "Graphite": "radial-gradient(circle at 25% 65%, #3a3a40cc, transparent 54%), radial-gradient(circle at 70% 30%, #2a2a2fcc, transparent 54%), radial-gradient(circle at 85% 80%, #4a5a7acc, transparent 31.5%), #161618",
 "Light": "radial-gradient(circle at 18% 62%, #f7cfe6cc, transparent 49.5%), radial-gradient(circle at 50% 50%, #d9ccf7cc, transparent 49.5%), radial-gradient(circle at 85% 15%, #cfe2ffcc, transparent 45%), #eceaf3"
};
export const SOLIDS = [["Canvas", "#1a1a1d"], ["Panel", "#1f1f22"], ["Raised", "#2c2c30"], ["Menu", "#3d3d44"], ["Lagoon ground", "#0d1a1b"], ["Lagoon accent", "#4fd1c0"], ["Lagoon deep", "#0a7a70"], ["Glass scrim", "#120a26"], ["Light canvas", "#f1f1f3"], ["Lagoon mist", "#edf4f3"]];
export const PHOTOS = [["Mountains", 1018], ["Coast", 1015], ["Forest", 1043], ["Lake", 1036], ["Desert", 1002], ["Night sky", 1022], ["Aurora", 1039], ["Valley", 1016]];
export function bgValue(key) {
  if (key.startsWith('p:')) return `url(https://picsum.photos/id/${Number(key.slice(2))}/1920/1080) center / cover`;
  if (key.startsWith('s:')) return key.slice(2);
  return BGS[key] || BGS.Glass;
}
