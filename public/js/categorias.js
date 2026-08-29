// ── Categorías Oficiales (DRAW) ──
export const CATEGORIAS = [
    'Masculino Suma 9',
    'Masculino Suma 10',
    'Masculino Suma 12',
    'Masculino 6ta Master',
    'Femenino Suma 10',
    'Femenino Suma 12',
    'Mixto Suma 11'
];

// ── Categorías de Jugador (inscripción) ──
export const CATEGORIAS_JUGADOR = ['3ra', '4ta', '5ta', '6ta Libre', '6ta Master', '7ma'];

export function isValidCategoria(cat) {
    return CATEGORIAS.includes(cat);
}
