const Joi = require("joi");

// Printable ASCII without whitespace, as sent in an "Authorization: Bearer <token>" header.
// An empty string or null removes a stored token on update.
const authTokenValidation = Joi.string().trim().max(1024).pattern(/^[\x21-\x7e]+$/).allow("", null);

const sourceCreationValidation = Joi.object({
    name: Joi.string().min(1).max(255).required(),
    url: Joi.string().uri().required(),
    authToken: authTokenValidation,
});

const sourceUpdateValidation = Joi.object({
    name: Joi.string().min(1).max(255),
    url: Joi.string().uri(),
    enabled: Joi.boolean(),
    authToken: authTokenValidation,
});

const validateUrlValidation = Joi.object({
    url: Joi.string().uri().required(),
    authToken: authTokenValidation,
});

module.exports = { sourceCreationValidation, sourceUpdateValidation, validateUrlValidation };
