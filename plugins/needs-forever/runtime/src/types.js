export function record(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Expected a JSON object.');
    return value;
}
export function text(value, field) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error(`${field} must be a nonempty string.`);
    return value;
}
