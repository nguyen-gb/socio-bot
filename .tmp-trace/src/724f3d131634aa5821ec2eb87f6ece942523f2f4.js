"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.withDeadline = withDeadline;
async function withDeadline(work, milliseconds, message) {
    let timer;
    try {
        return await Promise.race([work, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), milliseconds);
            })]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
//# sourceMappingURL=deadline.js.map