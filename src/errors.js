export class DomainError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = "DomainError";
    this.details = details;
    this.status = 400;
  }
}

export class NotFoundError extends DomainError {
  constructor(message, details = []) {
    super(message, details);
    this.name = "NotFoundError";
    this.status = 404;
  }
}

export class ConflictError extends DomainError {
  constructor(message, details = []) {
    super(message, details);
    this.name = "ConflictError";
    this.status = 409;
  }
}
