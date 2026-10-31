export const NOTICE_OUTPUT = 'school-notice-v1';
export const NOTICE_EXTRACTION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['actions'],
  properties: { actions: { type: 'array', maxItems: 6, items: {
    type: 'object', additionalProperties: false, required: ['paragraph', 'action', 'quote', 'dateText'],
    properties: { paragraph: { type: 'string' }, action: { type: 'string', maxLength: 240 },
      quote: { type: 'string', maxLength: 600 }, dateText: { type: ['string', 'null'], maxLength: 120 } },
  } } },
};
