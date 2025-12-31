/**
 * Tool System for AI Assistant
 * Provides JSON Patch (RFC 6902) interface for surgical edits to persistent JSON notes
 *
 * Tool calls are detected in the format:
 * <tool>read notes.json</tool>
 * <tool>patch notes.json
 * [{"op": "add", "path": "/key", "value": "data"}]
 * </tool>
 */

export class ToolSystem {
    constructor(store) {
        this.store = store;
        this.notesFile = 'notes.json';
        this.toolCallId = 0;

        // Initialize empty notes if they don't exist
        this._initializeNotes();
    }

    async _initializeNotes() {
        const notes = await this.store.getToolData(this.notesFile);
        if (!notes) {
            console.log('📝 Initializing new notes file...');
            await this.store.saveToolData(this.notesFile, {
                _metadata: {
                    created: new Date().toISOString(),
                    last_modified: new Date().toISOString(),
                    description: "AI assistant's persistent notes and memory"
                },
                topics: {},
                reminders: [],
                context: {},
                scratch: {}
            });
        } else {
            console.log('📝 Loaded existing notes:', Object.keys(notes));
        }
    }

    /**
     * Detect tool calls in generated text
     * Returns array of {start, end, raw, content, id} objects
     */
    detectToolCalls(text) {
        const toolCalls = [];
        const regex = /<tool>([\s\S]*?)<\/tool>/g;
        let match;

        while ((match = regex.exec(text)) !== null) {
            const content = match[1].trim();
            toolCalls.push({
                start: match.index,
                end: match.index + match[0].length,
                raw: match[0],
                content: content,
                command: content,  // Alias for compatibility with app.js
                id: ++this.toolCallId
            });
        }

        return toolCalls;
    }

    /**
     * Parse tool command into structured format
     * Supports: read <file>, patch <file> [operations]
     */
    parseCommand(content) {
        // Read command: "read notes.json"
        const readMatch = content.match(/^read\s+(\S+)$/);
        if (readMatch) {
            return { type: 'read', file: readMatch[1] };
        }

        // Patch command: "patch notes.json\n[...]"
        const patchMatch = content.match(/^patch\s+(\S+)\s*([\s\S]*)$/);
        if (patchMatch) {
            const file = patchMatch[1];
            const patchJson = patchMatch[2].trim();

            if (!patchJson) {
                return { type: 'error', error: 'Patch command requires JSON operations array' };
            }

            try {
                const operations = JSON.parse(patchJson);
                if (!Array.isArray(operations)) {
                    return { type: 'error', error: 'Patch operations must be an array' };
                }
                return { type: 'patch', file, operations };
            } catch (e) {
                return { type: 'error', error: `Invalid JSON in patch: ${e.message}` };
            }
        }

        return { type: 'error', error: `Unknown command. Use 'read <file>' or 'patch <file> [operations]'` };
    }

    /**
     * Execute a parsed command
     */
    async executeCommand(parsed) {
        if (parsed.type === 'error') {
            return { success: false, error: parsed.error };
        }

        if (parsed.type === 'read') {
            const data = await this.store.getToolData(parsed.file);
            if (!data) {
                return { success: false, error: `File not found: ${parsed.file}` };
            }
            return {
                success: true,
                output: JSON.stringify(data, null, 2),
                isWrite: false
            };
        }

        if (parsed.type === 'patch') {
            let data = await this.store.getToolData(parsed.file);
            if (!data) {
                data = {};  // Create new file if doesn't exist
            }

            try {
                // Apply each operation
                for (const op of parsed.operations) {
                    data = this._applyOperation(data, op);
                }

                // Update metadata
                data._metadata = data._metadata || {};
                data._metadata.last_modified = new Date().toISOString();

                await this.store.saveToolData(parsed.file, data);

                // Return compact confirmation
                const summary = parsed.operations.map(op => {
                    if (op.op === 'move' || op.op === 'copy') {
                        return `✓ ${op.op} ${op.from} → ${op.path}`;
                    }
                    return `✓ ${op.op} ${op.path}`;
                }).join('\n');

                return {
                    success: true,
                    output: summary,
                    isWrite: true
                };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }

        return { success: false, error: 'Unknown command type' };
    }

    /**
     * Apply a single JSON Patch operation (RFC 6902)
     */
    _applyOperation(data, op) {
        if (!op.op) {
            throw new Error('Operation missing "op" field');
        }
        if (!op.path && op.path !== '') {
            throw new Error('Operation missing "path" field');
        }

        const path = this._parsePath(op.path);

        switch (op.op) {
            case 'add':
                if (op.value === undefined) {
                    throw new Error('Add operation missing "value" field');
                }
                return this._setPath(data, path, op.value, true);

            case 'replace':
                if (op.value === undefined) {
                    throw new Error('Replace operation missing "value" field');
                }
                // Check path exists first
                if (path.length > 0 && this._getPath(data, path) === undefined) {
                    throw new Error(`Path not found for replace: ${op.path}`);
                }
                return this._setPath(data, path, op.value, false);

            case 'remove':
                return this._removePath(data, path);

            case 'move': {
                if (!op.from) {
                    throw new Error('Move operation missing "from" field');
                }
                const fromPath = this._parsePath(op.from);
                const value = this._getPath(data, fromPath);
                if (value === undefined) {
                    throw new Error(`Source path not found: ${op.from}`);
                }
                data = this._removePath(data, fromPath);
                return this._setPath(data, path, value, true);
            }

            case 'copy': {
                if (!op.from) {
                    throw new Error('Copy operation missing "from" field');
                }
                const srcPath = this._parsePath(op.from);
                const srcValue = this._getPath(data, srcPath);
                if (srcValue === undefined) {
                    throw new Error(`Source path not found: ${op.from}`);
                }
                // Deep copy the value
                return this._setPath(data, path, JSON.parse(JSON.stringify(srcValue)), true);
            }

            case 'test': {
                if (op.value === undefined) {
                    throw new Error('Test operation missing "value" field');
                }
                const actual = this._getPath(data, path);
                if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
                    throw new Error(`Test failed at ${op.path}: expected ${JSON.stringify(op.value)}, got ${JSON.stringify(actual)}`);
                }
                return data;
            }

            default:
                throw new Error(`Unknown operation: ${op.op}. Valid operations: add, remove, replace, move, copy, test`);
        }
    }

    /**
     * Parse a JSON Pointer path (RFC 6901) into array of keys
     * "/a/b/c" -> ["a", "b", "c"]
     * "" -> []
     */
    _parsePath(path) {
        if (path === '' || path === '/') {
            return [];
        }
        if (!path.startsWith('/')) {
            throw new Error(`Invalid path: "${path}". Paths must start with / or be empty`);
        }
        return path.substring(1).split('/').map(segment => {
            // Unescape JSON Pointer special chars (RFC 6901)
            return segment.replace(/~1/g, '/').replace(/~0/g, '~');
        });
    }

    /**
     * Get value at path
     */
    _getPath(obj, path) {
        let current = obj;
        for (const key of path) {
            if (current === undefined || current === null) {
                return undefined;
            }
            // Handle array index
            if (Array.isArray(current)) {
                const index = parseInt(key, 10);
                if (isNaN(index)) {
                    return undefined;
                }
                current = current[index];
            } else {
                current = current[key];
            }
        }
        return current;
    }

    /**
     * Set value at path
     * @param {object} obj - The object to modify
     * @param {string[]} path - Array of keys
     * @param {*} value - Value to set
     * @param {boolean} create - If true, create missing parents
     */
    _setPath(obj, path, value, create = false) {
        if (path.length === 0) {
            return value;  // Replace root
        }

        const result = JSON.parse(JSON.stringify(obj));
        let current = result;

        for (let i = 0; i < path.length - 1; i++) {
            const key = path[i];

            if (Array.isArray(current)) {
                const index = parseInt(key, 10);
                if (isNaN(index)) {
                    throw new Error(`Invalid array index: ${key}`);
                }
                if (current[index] === undefined) {
                    if (!create) {
                        throw new Error(`Path not found: /${path.slice(0, i + 1).join('/')}`);
                    }
                    current[index] = {};
                }
                current = current[index];
            } else {
                if (current[key] === undefined) {
                    if (!create) {
                        throw new Error(`Path not found: /${path.slice(0, i + 1).join('/')}`);
                    }
                    current[key] = {};
                }
                current = current[key];
            }
        }

        const lastKey = path[path.length - 1];

        // Handle array append with "-"
        if (Array.isArray(current) && lastKey === '-') {
            current.push(value);
        } else if (Array.isArray(current)) {
            const index = parseInt(lastKey, 10);
            if (isNaN(index)) {
                throw new Error(`Invalid array index: ${lastKey}`);
            }
            current[index] = value;
        } else {
            current[lastKey] = value;
        }

        return result;
    }

    /**
     * Remove value at path
     */
    _removePath(obj, path) {
        if (path.length === 0) {
            return {};  // Remove root = empty object
        }

        const result = JSON.parse(JSON.stringify(obj));
        let current = result;

        for (let i = 0; i < path.length - 1; i++) {
            const key = path[i];
            if (Array.isArray(current)) {
                const index = parseInt(key, 10);
                current = current[index];
            } else {
                current = current[key];
            }
            if (current === undefined) {
                return result;  // Path doesn't exist, nothing to remove
            }
        }

        const lastKey = path[path.length - 1];
        if (Array.isArray(current)) {
            const index = parseInt(lastKey, 10);
            if (!isNaN(index)) {
                current.splice(index, 1);
            }
        } else {
            delete current[lastKey];
        }

        return result;
    }

    /**
     * Format tool result for display
     */
    formatResult(result) {
        if (!result.success) {
            return `❌ Error: ${result.error}`;
        }

        if (result.output) {
            return result.output;
        }

        console.warn('Tool result has no output:', result);
        return '{}';
    }

    /**
     * Get system prompt addition with tool instructions
     * @param {boolean} includeCurrentState - Whether to include current notes state
     */
    async getSystemPromptAddition(includeCurrentState = true) {
        let prompt = `
## Tool Use

You have a persistent JSON file for notes. Use these commands:

### Read (see current state)
<tool>read notes.json</tool>

### Patch (surgical edits - RFC 6902 JSON Patch)
<tool>patch notes.json
[
  {"op": "add", "path": "/memories/cat_name", "value": "Nightmare"},
  {"op": "replace", "path": "/context/mood", "value": "happy"},
  {"op": "remove", "path": "/scratch/temp"}
]
</tool>

**Operations:**
- \`add\` - Add/set value at path (creates parents)
- \`remove\` - Delete value at path
- \`replace\` - Replace existing value (path must exist)
- \`move\` - Move from one path to another (requires "from" field)
- \`copy\` - Copy from one path to another (requires "from" field)
- \`test\` - Assert value equals (fails if not)

**Path format:** /root/child/grandchild (with leading /)
**Array append:** Use "/-" as path suffix to add to end of array

Use \`read\` first if unsure of structure. Use \`patch\` for changes.
`;

        if (includeCurrentState) {
            try {
                const notes = await this.store.getToolData(this.notesFile);
                if (notes) {
                    const preview = this._getJSONPreview(notes, 2);
                    prompt += `
### Current Notes State:
\`\`\`json
${preview}
\`\`\`

Note: {...} indicates deeper structure. Use \`<tool>read notes.json</tool>\` to see full content.
`;
                }
            } catch (err) {
                console.warn('Could not load notes for system prompt:', err);
            }
        }

        prompt += `
Always use tool calls when you need to remember something important or retrieve previously stored information.`;

        return prompt;
    }

    /**
     * Get the full notes content (for UI editing)
     * @returns {Promise<Object>} The notes JSON object
     */
    async getNotesContent() {
        return await this.store.getToolData(this.notesFile);
    }

    /**
     * Set the full notes content (for UI editing)
     * @param {Object} content - The new notes content
     */
    async setNotesContent(content) {
        if (content && typeof content === 'object') {
            if (!content._metadata) {
                content._metadata = {};
            }
            content._metadata.last_modified = new Date().toISOString();
            content._metadata.edited_by = 'user';
        }
        await this.store.saveToolData(this.notesFile, content);
    }

    /**
     * Get JSON preview showing top N levels of structure
     * @param {object} notes - The notes object
     * @param {number} depth - How many levels deep to show (default 2)
     */
    _getJSONPreview(notes, depth = 2) {
        if (!notes) {
            return '{}';
        }

        const truncateDepth = (obj, currentDepth) => {
            if (currentDepth <= 0 || typeof obj !== 'object' || obj === null) {
                if (typeof obj === 'object' && obj !== null) {
                    return Array.isArray(obj) ? '[...]' : '{...}';
                }
                return obj;
            }

            if (Array.isArray(obj)) {
                const preview = obj.slice(0, 3).map(item => truncateDepth(item, currentDepth - 1));
                if (obj.length > 3) {
                    preview.push('...');
                }
                return preview;
            }

            const result = {};
            for (const [key, value] of Object.entries(obj)) {
                result[key] = truncateDepth(value, currentDepth - 1);
            }
            return result;
        };

        const preview = truncateDepth(notes, depth);
        return JSON.stringify(preview, null, 2);
    }
}
