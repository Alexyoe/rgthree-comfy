import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";
const LAST_SEED_BUTTON_LABEL = '♻️ (Use Last Queued Seed)';
class SeedControl {
    constructor(node) {
        this.lastSeed = -1;
        this.serializedCtx = {};
        this.lastSeedValue = null;
        this.node = node;
        this.node.properties = this.node.properties || {};
        for (const [i, w] of this.node.widgets.entries()) {
            if (w.name === 'seed') {
                this.seedWidget = w;
            }
            else if (w.name === 'control_after_generate') {
                this.node.widgets.splice(i, 1);
            }
        }
        if (!this.seedWidget) {
            throw new Error('Something\'s wrong; expected seed widget');
        }
        const max = Math.min(1125899906842624, this.seedWidget.options.max);
        const min = Math.max(-1125899906842624, this.seedWidget.options.min);
        const range = (max - min) / (this.seedWidget.options.step / 10);
        this.node.addWidget('button', '🎲 Randomize Each Time', null, () => {
            this.seedWidget.value = -1;
        }, { serialize: false });
        this.node.addWidget('button', '🎲 New Fixed Random', null, () => {
            this.seedWidget.value = Math.floor(Math.random() * range) * (this.seedWidget.options.step / 10) + min;
        }, { serialize: false });
        this.lastSeedButton = this.node.addWidget("button", LAST_SEED_BUTTON_LABEL, null, () => {
            this.seedWidget.value = this.lastSeed;
            this.lastSeedButton.name = LAST_SEED_BUTTON_LABEL;
            this.lastSeedButton.disabled = true;
        }, { width: 50, serialize: false });
        this.lastSeedButton.disabled = true;
        this.seedWidget.serializeValue = async (node, index) => {
            const currentSeed = this.seedWidget.value;
            this.serializedCtx = {
                wasRandom: currentSeed == -1,
            };
            if (this.serializedCtx.wasRandom) {
                this.serializedCtx.seedUsed = Math.floor(Math.random() * range) * (this.seedWidget.options.step / 10) + min;
            }
            else {
                this.serializedCtx.seedUsed = this.seedWidget.value;
            }
            node.widgets_values[index] = this.serializedCtx.seedUsed;
            this.seedWidget.value = this.serializedCtx.seedUsed;
            if (this.serializedCtx.wasRandom) {
                this.lastSeed = this.serializedCtx.seedUsed;
                this.lastSeedButton.name = `♻️ ${this.serializedCtx.seedUsed}`;
                this.lastSeedButton.disabled = false;
                if (this.lastSeedValue) {
                    this.lastSeedValue.value = `Last Seed: ${this.serializedCtx.seedUsed}`;
                }
            }
            else {
                this.lastSeedButton.name = LAST_SEED_BUTTON_LABEL;
                this.lastSeedButton.disabled = true;
            }
            return this.serializedCtx.seedUsed;
        };
        this.seedWidget.afterQueued = () => {
            if (this.serializedCtx.wasRandom) {
                this.seedWidget.value = -1;
            }
            this.serializedCtx = {};
        };
        this.node.getExtraMenuOptions = (_, options) => {
            options.splice(options.length - 1, 0, {
                content: "Show/Hide Last Seed Value",
                callback: (_value, _options, _event, _parentMenu, _node) => {
                    this.node.properties['showLastSeed'] = !this.node.properties['showLastSeed'];
                    if (this.node.properties['showLastSeed']) {
                        this.addLastSeedValue();
                    }
                    else {
                        this.removeLastSeedValue();
                    }
                }
            });
        };
    }
    addLastSeedValue() {
        if (this.lastSeedValue)
            return;
        this.lastSeedValue = ComfyWidgets["STRING"](this.node, "last_seed", ["STRING", { multiline: true }], app).widget;
        this.lastSeedValue.inputEl.readOnly = true;
        this.lastSeedValue.inputEl.style.fontSize = '0.75rem';
        this.lastSeedValue.inputEl.style.textAlign = 'center';
        this.lastSeedValue.serializeValue = async (node, index) => {
            node.widgets_values[index] = '';
            return '';
        };
        this.node.computeSize();
    }
    removeLastSeedValue() {
        if (!this.lastSeedValue)
            return;
        this.lastSeedValue.inputEl.remove();
        this.node.widgets.splice(this.node.widgets.indexOf(this.lastSeedValue), 1);
        this.lastSeedValue = null;
        this.node.computeSize();
    }
}
app.registerExtension({
    name: "rgthree.Seed",
    async beforeRegisterNodeDef(nodeType, nodeData, _app) {
        if (nodeData.name === "Seed (rgthree)") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                onNodeCreated ? onNodeCreated.apply(this, []) : undefined;
                this.seedControl = new SeedControl(this);
            };
        }
    },
});
