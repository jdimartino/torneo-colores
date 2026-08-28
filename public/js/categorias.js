// ── Categorías Oficiales ──
export const CATEGORIAS = [
    'Masculino Suma 9',
    'Masculino Suma 10',
    'Masculino Suma 12',
    'Masculino 6ta Master',
    'Femenino Suma 10',
    'Femenino Suma 12',
    'Mixto Suma 11'
];

export function isValidCategoria(cat) {
    return CATEGORIAS.includes(cat);
}
