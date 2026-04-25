// Mock for ioredis to avoid dependency in test environment
class Redis {
  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.connected = false;
  }

  on(event, callback) {
    if (event === 'connect') {
      setTimeout(() => {
        this.connected = true;
        callback();
      }, 0);
    }
    return this;
  }

  async quit() {
    this.connected = false;
    return 'OK';
  }
}

export { Redis };
export default Redis;
