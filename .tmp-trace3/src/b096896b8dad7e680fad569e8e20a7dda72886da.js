"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProfileLeaseService = void 0;
const node_crypto_1 = require("node:crypto");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const ioredis_1 = __importDefault(require("ioredis"));
const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;
const REFRESH_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;
let ProfileLeaseService = class ProfileLeaseService {
    redis;
    ttlMs;
    constructor(config) {
        this.redis = new ioredis_1.default(config.get('redisUrl', { infer: true }), {
            maxRetriesPerRequest: 2,
            enableReadyCheck: true,
        });
        this.ttlMs = config.get('profileLeaseTtlMs', { infer: true });
    }
    async withLease(profileId, callback, options = {}) {
        const key = `profile-lease:${profileId}`;
        const token = (0, node_crypto_1.randomUUID)();
        const deadline = Date.now() + (options.waitTimeoutMs ?? 0);
        while (await this.redis.set(key, token, 'PX', this.ttlMs, 'NX') !== 'OK') {
            if (Date.now() >= deadline)
                throw new Error(`Browser profile ${profileId} is already leased`);
            options.onWait?.();
            await new Promise((resolve) => setTimeout(resolve, Math.min(1000, deadline - Date.now())));
        }
        const refresh = setInterval(() => {
            void this.redis.eval(REFRESH_SCRIPT, 1, key, token, this.ttlMs.toString());
        }, Math.max(5_000, Math.floor(this.ttlMs / 3)));
        refresh.unref();
        try {
            return await callback();
        }
        finally {
            clearInterval(refresh);
            await this.redis.eval(RELEASE_SCRIPT, 1, key, token);
        }
    }
    async onModuleDestroy() {
        await this.redis.quit();
    }
};
exports.ProfileLeaseService = ProfileLeaseService;
exports.ProfileLeaseService = ProfileLeaseService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [config_1.ConfigService])
], ProfileLeaseService);
//# sourceMappingURL=profile-lease.service.js.map