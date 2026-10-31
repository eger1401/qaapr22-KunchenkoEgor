// Генерирует картинки для вопросов в media/: флаги, контуры стран, города на карте Украины.
// Нужны пакеты (только для генерации, игре они не нужны):
//   npm install world-atlas@2.0.2 topojson-client@3.1.0 d3-geo@3.1.1
// Запуск: NODE_PATH=путь/к/node_modules node tools/build-media.js
// Данные карт: Natural Earth (public domain) через world-atlas.
// Украина рисуется в международно признанных границах (вместе с Крымом).

const fs = require('fs');
const path = require('path');
const topo = require('topojson-client');
const d3 = require('d3-geo');
const world = require('world-atlas/countries-50m.json');

const OUT = path.join(__dirname, '..', 'media');
fs.mkdirSync(path.join(OUT, 'flags'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'maps'), { recursive: true });
const save = (rel, svg) => fs.writeFileSync(path.join(OUT, rel), svg.trim() + '\n');

// ---------- флаги ----------
const W = 300;
const frame = (w, h, body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" fill="none" stroke="#000" stroke-opacity=".25"/></svg>`;
const hStripes = (h, colors) => frame(W, h, colors.map((c, i) => `<rect x="0" y="${(h / colors.length) * i}" width="${W}" height="${h / colors.length + 0.5}" fill="${c}"/>`).join(''));
const vStripes = (h, colors) => frame(W, h, colors.map((c, i) => `<rect x="${(W / colors.length) * i}" y="0" width="${W / colors.length + 0.5}" height="${h}" fill="${c}"/>`).join(''));
const nordic = (h, bg, cross, ux, uy) => frame(W, h, `<rect width="${W}" height="${h}" fill="${bg}"/><rect x="${ux * 5}" y="0" width="${ux * 2}" height="${h}" fill="${cross}"/><rect x="0" y="${uy * 4}" width="${W}" height="${uy * 2}" fill="${cross}"/>`);

const flags = {
  japan: frame(W, 200, `<rect width="300" height="200" fill="#fff"/><circle cx="150" cy="100" r="60" fill="#BC002D"/>`),
  germany: hStripes(180, ['#000000', '#DD0000', '#FFCE00']),
  italy: vStripes(200, ['#009246', '#FFFFFF', '#CE2B37']),
  sweden: nordic(187.5, '#006AA7', '#FECC00', W / 16, 187.5 / 10),
  ireland: vStripes(150, ['#169B62', '#FFFFFF', '#FF883E']),
  ukraine: hStripes(200, ['#0057B7', '#FFD700']),
  poland: hStripes(187.5, ['#FFFFFF', '#DC143C']),
  switzerland: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="200" height="200"><rect width="32" height="32" fill="#DA291C"/><rect x="13" y="6" width="6" height="20" fill="#fff"/><rect x="6" y="13" width="20" height="6" fill="#fff"/></svg>`,
  netherlands: hStripes(200, ['#AE1C28', '#FFFFFF', '#21468B']),
  belgium: vStripes(260, ['#000000', '#FAE042', '#ED2939']),
};
for (const [n, svg] of Object.entries(flags)) save(`flags/${n}.svg`, svg);

// ---------- карты ----------
const countries = topo.feature(world, world.objects.countries).features;
const byName = (n) => countries.find((f) => f.properties.name === n);

function polygons(f) {
  return f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
}
// оставляем крупные части (убираем далёкие крошечные острова)
function mainland(f, keep = 0.01) {
  const polys = polygons(f).map((c) => ({ c, a: d3.geoArea({ type: 'Polygon', coordinates: c }) }));
  const max = Math.max(...polys.map((p) => p.a));
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys.filter((p) => p.a >= max * keep).map((p) => p.c) } };
}

function ukraine() {
  const ua = byName('Ukraine');
  const ru = byName('Russia');
  const crimea = polygons(ru).filter((c) => d3.geoContains({ type: 'Polygon', coordinates: c }, [34.1, 44.95]));
  if (crimea.length !== 1) throw new Error('Не нашли Крым');
  const b = d3.geoBounds({ type: 'Polygon', coordinates: crimea[0] });
  if (b[0][0] < 32 || b[1][0] > 37 || b[0][1] < 44 || b[1][1] > 46.5) throw new Error('Полигон Крыма выглядит неправильно: ' + JSON.stringify(b));
  return { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: [...polygons(ua), crimea[0]] } };
}

function mapSvg(feature, { width = 400, dot = null } = {}) {
  const proj = d3.geoMercator();
  if (feature === 'ua') feature = ukraine();
  // высота по пропорциям страны
  proj.fitWidth(width - 20, feature);
  const [[x0, y0], [x1, y1]] = d3.geoPath(proj).bounds(feature);
  const height = Math.ceil(y1 - y0 + 20);
  proj.fitExtent([[10, 10], [width - 10, height - 10]], feature);
  const d = d3.geoPath(proj).digits(1)(feature);
  let extra = '';
  if (dot) {
    const [x, y] = proj(dot);
    extra = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="16" fill="#ff4d5e" fill-opacity=".3"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7" fill="#ff4d5e" stroke="#fff" stroke-width="2"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><path d="${d}" fill="#f6c453" stroke="#7a5c12" stroke-width="1" stroke-linejoin="round"/>${extra}</svg>`;
}

const shapes = { italy: 'Italy', australia: 'Australia', japan: 'Japan', uk: 'United Kingdom', chile: 'Chile' };
for (const [file, n] of Object.entries(shapes)) save(`maps/country-${file}.svg`, mapSvg(mainland(byName(n), n === 'Chile' ? 0.02 : 0.005), { width: n === 'Chile' ? 220 : 400 }));

const cities = { kyiv: [30.52, 50.45], odesa: [30.73, 46.48], lviv: [24.03, 49.84], kharkiv: [36.23, 49.99], poltava: [34.55, 49.59] };
for (const [file, xy] of Object.entries(cities)) save(`maps/ua-${file}.svg`, mapSvg('ua', { dot: xy }));
save('maps/ukraine.svg', mapSvg('ua'));

console.log('Готово:', fs.readdirSync(path.join(OUT, 'flags')).length, 'флагов,', fs.readdirSync(path.join(OUT, 'maps')).length, 'карт');
