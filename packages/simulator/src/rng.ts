export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    if (!Number.isInteger(seed)) throw new Error('Seed must be an integer');
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  integer(maximumExclusive: number): number {
    if (!Number.isInteger(maximumExclusive) || maximumExclusive <= 0)
      throw new Error('Random integer bound must be positive');
    return Math.floor(this.next() * maximumExclusive);
  }

  normal(): number {
    const first = Math.max(this.next(), Number.EPSILON);
    const second = this.next();
    return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
  }

  fork(salt: number): SeededRandom {
    return new SeededRandom((this.state ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}
