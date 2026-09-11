// Pin endpoint and limits as well as model identity so a resumed tool turn stays portable.
export default `
ALTER TABLE sessions ADD COLUMN model_ref TEXT;
ALTER TABLE runs ADD COLUMN provider_config TEXT;
`;
