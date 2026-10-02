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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskArtifactsService = void 0;
const node_crypto_1 = require("node:crypto");
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const browser_runtime_1 = require("@socio/browser-runtime");
const prisma_service_1 = require("../database/prisma.service");
const object_storage_providers_1 = require("./object-storage.providers");
let TaskArtifactsService = class TaskArtifactsService {
    prisma;
    config;
    objects;
    constructor(prisma, config, objects) {
        this.prisma = prisma;
        this.config = config;
        this.objects = objects;
    }
    async captureFailure(taskId, taskRunId, page) {
        const path = (0, node_path_1.resolve)(this.config.get('artifactRoot', { infer: true }), `failure-${(0, node_crypto_1.randomUUID)()}.png`);
        try {
            await (0, promises_1.mkdir)(this.config.get('artifactRoot', { infer: true }), {
                recursive: true,
            });
            await page.screenshot({ path, fullPage: true, timeout: 5_000 });
            const stored = await this.objects.putFile(`artifacts/tasks/${taskId}/runs/${taskRunId}/failure.png`, path, 'image/png');
            await this.prisma.artifact.create({
                data: {
                    taskId,
                    taskRunId,
                    type: 'FAILURE_SCREENSHOT',
                    storageUri: stored.uri,
                    contentType: 'image/png',
                    sizeBytes: BigInt(stored.sizeBytes),
                },
            });
        }
        finally {
            await (0, promises_1.rm)(path, { force: true });
        }
    }
    async temporaryPath(extension) {
        const root = this.config.get('artifactRoot', { infer: true });
        await (0, promises_1.mkdir)(root, { recursive: true });
        return (0, node_path_1.resolve)(root, `${(0, node_crypto_1.randomUUID)()}${extension}`);
    }
    async captureScreenshot(taskId, taskRunId, page, type) {
        const fileName = type === 'BEFORE_SCREENSHOT' ? 'before.png' : 'after.png';
        const path = await this.temporaryPath('.png');
        try {
            await page.screenshot({ path, fullPage: true, timeout: 5_000 });
            await this.storeFile(taskId, taskRunId, type, fileName, path, 'image/png');
        }
        finally {
            await (0, promises_1.rm)(path, { force: true });
        }
    }
    async captureTrace(taskId, taskRunId, context) {
        const path = await this.temporaryPath('.zip');
        try {
            await (0, browser_runtime_1.withDeadline)(context.tracing.stop({ path }), 8_000, 'Trace capture timed out');
            await this.storeFile(taskId, taskRunId, 'PLAYWRIGHT_TRACE', 'trace.zip', path, 'application/zip');
        }
        finally {
            await (0, promises_1.rm)(path, { force: true });
        }
    }
    async captureConsoleLog(taskId, taskRunId, lines) {
        if (lines.length === 0)
            return;
        const bytes = Buffer.from(lines.join('\n').slice(0, 1_000_000), 'utf8');
        const stored = await this.objects.putBytes(`artifacts/tasks/${taskId}/runs/${taskRunId}/console.log`, bytes, 'text/plain; charset=utf-8');
        await this.createRecord(taskId, taskRunId, 'CONSOLE_LOG', stored, 'text/plain; charset=utf-8');
    }
    async captureHar(taskId, taskRunId, path) {
        try {
            const parsed = JSON.parse(await (0, promises_1.readFile)(path, 'utf8'));
            sanitizeHar(parsed);
            const bytes = Buffer.from(JSON.stringify(parsed), 'utf8');
            const stored = await this.objects.putBytes(`artifacts/tasks/${taskId}/runs/${taskRunId}/network.har`, bytes, 'application/json');
            await this.createRecord(taskId, taskRunId, 'NETWORK_HAR', stored, 'application/json');
        }
        finally {
            await (0, promises_1.rm)(path, { force: true });
        }
    }
    async storeFile(taskId, taskRunId, type, fileName, path, contentType) {
        const stored = await this.objects.putFile(`artifacts/tasks/${taskId}/runs/${taskRunId}/${fileName}`, path, contentType);
        await this.createRecord(taskId, taskRunId, type, stored, contentType);
    }
    async createRecord(taskId, taskRunId, type, stored, contentType) {
        await this.prisma.artifact.create({
            data: {
                taskId,
                taskRunId,
                type,
                storageUri: stored.uri,
                contentType,
                sizeBytes: BigInt(stored.sizeBytes),
            },
        });
    }
};
exports.TaskArtifactsService = TaskArtifactsService;
exports.TaskArtifactsService = TaskArtifactsService = __decorate([
    (0, common_1.Injectable)(),
    __param(2, (0, common_1.Inject)(object_storage_providers_1.OBJECT_STORAGE)),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService, config_1.ConfigService, Object])
], TaskArtifactsService);
function sanitizeHar(value) {
    if (!value || typeof value !== 'object')
        return;
    const object = value;
    if (typeof object.url === 'string') {
        try {
            const url = new URL(object.url);
            url.search = '';
            url.hash = '';
            object.url = url.toString();
        }
        catch {
            object.url = '[invalid-url]';
        }
    }
    if (Array.isArray(object.headers)) {
        for (const header of object.headers) {
            if (!header || typeof header !== 'object')
                continue;
            const item = header;
            if (typeof item.name === 'string' &&
                /^(authorization|cookie|set-cookie|proxy-authorization)$/i.test(item.name)) {
                item.value = '[REDACTED]';
            }
        }
    }
    if ('cookies' in object)
        object.cookies = [];
    if ('postData' in object)
        object.postData = { text: '[REDACTED]' };
    for (const child of Object.values(object)) {
        if (Array.isArray(child))
            child.forEach(sanitizeHar);
        else
            sanitizeHar(child);
    }
}
//# sourceMappingURL=task-artifacts.service.js.map