export class ApiError extends Error {
  statusCode: number;
  code: string;
  constructor(statusCode: number, message: string, code = 'ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export const badRequest = (msg: string) => new ApiError(400, msg, 'BAD_REQUEST');
export const unauthorized = (msg = '未登录或登录已过期') => new ApiError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = '无权访问') => new ApiError(403, msg, 'FORBIDDEN');
export const notFound = (msg = '资源不存在') => new ApiError(404, msg, 'NOT_FOUND');
export const tooMany = (msg = '操作过于频繁') => new ApiError(429, msg, 'TOO_MANY');
