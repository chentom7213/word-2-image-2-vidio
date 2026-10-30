export type AccessLogFields = {
  traceId: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  userId?: string;
  taskId?: string;
};

/** Request log fields. Email is never included. taskId only for a generation route. */
export function accessLogFields(input: {
  traceId: string;
  method: string;
  url: string;
  status: number;
  ms: number;
  userId?: string;
  route?: string;
  paramId?: string;
}): AccessLogFields {
  const fields: AccessLogFields = {
    traceId: input.traceId,
    method: input.method,
    url: input.url,
    status: input.status,
    ms: input.ms,
  };
  if (input.userId) fields.userId = input.userId;
  if (input.route?.startsWith('/api/generations/') && input.paramId) fields.taskId = input.paramId;
  return fields;
}
