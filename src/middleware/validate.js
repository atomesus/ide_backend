const { badRequest } = require("../lib/errors");

/** zod validation of req.body / req.query / req.params; parsed values replace the originals. */
function validate(schemas) {
  return (req, res, next) => {
    for (const part of ["body", "query", "params"]) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part] ?? {});
      if (!result.success) {
        const first = result.error.issues[0];
        const where = first?.path?.length ? `${first.path.join(".")}: ` : "";
        return next(badRequest(`${where}${first?.message || "Invalid request"}`, "validation_error"));
      }
      if (part === "query") {
        // Express 5 exposes req.query as a getter; keep the parsed copy alongside.
        req.validatedQuery = result.data;
      } else {
        req[part] = result.data;
      }
    }
    next();
  };
}

module.exports = { validate };
