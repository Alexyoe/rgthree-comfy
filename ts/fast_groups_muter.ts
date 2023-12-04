// / <reference path="../node_modules/litegraph.js/src/litegraph.d.ts" />
// @ts-ignore
import { app } from "../../scripts/app.js";
import { RgthreeBaseNode } from "./base_node.js";
import { NodeTypesString } from "./constants.js";
import {
  type LGraphNode,
  type LGraph as TLGraph,
  type LiteGraph as TLiteGraph,
  LGraphCanvas as TLGraphCanvas,
  Vector2,
  SerializedLGraphNode,
  IWidget,
  LGraphGroup,
} from "./typings/litegraph.js";
import { fitString } from "./utils_canvas.js";

declare const LGraphCanvas: typeof TLGraphCanvas;
declare const LiteGraph: typeof TLiteGraph;

const PROPERTY_SORT = "sort";
const PROPERTY_SORT_CUSTOM_ALPHA = "customSortAlphabet";
const PROPERTY_MATCH_COLORS = "matchColors";
const PROPERTY_MATCH_TITLE = "matchTitle";
const PROPERTY_SHOW_NAV = "showNav";

/**
 * A service that keeps global state that can be shared by multiple FastGroupsMuter or
 * FastGroupsBypasser nodes rather than calculate it on it's own.
 */
class FastGroupsService {
  private msThreshold = 400;
  private msLastUnsorted = 0;
  private msLastAlpha = 0;
  private msLastPosition = 0;

  private groupsUnsorted: LGraphGroup[] = [];
  private groupsSortedAlpha: LGraphGroup[] = [];
  private groupsSortedPosition: LGraphGroup[] = [];

  private readonly fastGroupNodes: FastGroupsMuter[] = [];

  constructor() {
    // Don't need to do anything, wait until a signal.
  }

  addFastGroupNode(node: FastGroupsMuter) {
    this.fastGroupNodes.push(node);
    if (this.fastGroupNodes.length === 1) {
      this.run();
    } else {
      node.refreshWidgets();
    }
  }

  removeFastGroupNode(node: FastGroupsMuter) {
    const index = this.fastGroupNodes.indexOf(node);
    if (index > -1) {
      this.fastGroupNodes.splice(index, 1);
    }
  }

  run() {
    for (const node of this.fastGroupNodes) {
      node.refreshWidgets();
    }
    if (this.fastGroupNodes.length) {
      setTimeout(() => {
        this.run();
      }, 500);
    }
  }

  private getGroupsUnsorted(now: number) {
    const graph = app.graph as TLGraph;
    if (!this.groupsUnsorted.length || now - this.msLastUnsorted > this.msThreshold) {
      this.groupsUnsorted = [...graph._groups];
      for (const group of this.groupsUnsorted) {
        group.recomputeInsideNodes();
        (group as any)._rgthreeHasAnyActiveNode = group._nodes.some(
          (n) => n.mode === LiteGraph.ALWAYS,
        );
      }
      this.msLastUnsorted = now;
    }
    return this.groupsUnsorted;
  }

  private getGroupsAlpha(now: number) {
    const graph = app.graph as TLGraph;
    if (!this.groupsSortedAlpha.length || now - this.msLastAlpha > this.msThreshold) {
      this.groupsSortedAlpha = [...this.getGroupsUnsorted(now)].sort((a, b) => {
        return a.title.localeCompare(b.title);
      });
      this.msLastAlpha = now;
    }
    return this.groupsSortedAlpha;
  }

  private getGroupsPosition(now: number) {
    const graph = app.graph as TLGraph;
    if (!this.groupsSortedPosition.length || now - this.msLastPosition > this.msThreshold) {
      this.groupsSortedPosition = [...this.getGroupsUnsorted(now)].sort((a, b) => {
        // Sort by y, then x, clamped to 30.
        const aY = Math.floor(a._pos[1] / 30);
        const bY = Math.floor(b._pos[1] / 30);
        if (aY == bY) {
          const aX = Math.floor(a._pos[0] / 30);
          const bX = Math.floor(b._pos[0] / 30);
          return aX - bX;
        }
        return aY - bY;
      });
      this.msLastPosition = now;
    }
    return this.groupsSortedPosition;
  }

  getGroups(sort?: string) {
    const now = +new Date();
    if (sort === "alphanumeric") {
      return this.getGroupsAlpha(now);
    }
    if (sort === "position") {
      return this.getGroupsPosition(now);
    }
    return this.getGroupsUnsorted(now);
  }
}

const SERVICE = new FastGroupsService();

/**
 * Fast Muter implementation that looks for groups in the workflow and adds toggles to mute them.
 */
export class FastGroupsMuter extends RgthreeBaseNode {
  static override type = NodeTypesString.FAST_GROUPS_MUTER;
  static override title = NodeTypesString.FAST_GROUPS_MUTER;

  override isVirtualNode = true;

  static override exposedActions = ["Mute all", "Enable all"];

  readonly modeOn: number = LiteGraph.ALWAYS;
  readonly modeOff: number = LiteGraph.NEVER;

  private debouncerTempWidth: number = 0;
  tempSize: Vector2 | null = null;

  // We don't need to serizalize since we'll just be checking group data on startup anyway
  override serialize_widgets = false;

  protected helpActions = "must and unmute";

  static "@matchColors" = { type: "string" };
  static "@matchTitle" = { type: "string" };
  static "@showNav" = { type: "boolean" };
  static "@sort" = {
    type: "combo",
    values: ["position", "alphanumeric", "custom alphabet"],
  };
  static "@customSortAlphabet" = { type: "string" };

  constructor(title = FastGroupsMuter.title) {
    super(title);
    this.properties[PROPERTY_MATCH_COLORS] = "";
    this.properties[PROPERTY_MATCH_TITLE] = "";
    this.properties[PROPERTY_SHOW_NAV] = true;
    this.properties[PROPERTY_SORT] = "position";
    this.properties[PROPERTY_SORT_CUSTOM_ALPHA] = "";
    this.addOutput("OPT_CONNECTION", "*");
  }

  override onAdded(graph: TLGraph): void {
    SERVICE.addFastGroupNode(this);
  }

  override onRemoved(): void {
    SERVICE.removeFastGroupNode(this);
  }

  refreshWidgets() {
    let sort = this.properties?.[PROPERTY_SORT] || "position";
    let customAlphabet: string[] | null = null;
    if (sort === "custom alphabet") {
      const customAlphaStr = this.properties?.[PROPERTY_SORT_CUSTOM_ALPHA]?.replace(/\n/g, "");
      if (customAlphaStr && customAlphaStr.trim()) {
        customAlphabet = customAlphaStr.includes(",")
          ? customAlphaStr.toLocaleLowerCase().split(",")
          : customAlphaStr.toLocaleLowerCase().trim().split("");
      }
      if (!customAlphabet?.length) {
        sort = "alphanumeric";
        customAlphabet = null;
      }
    }

    const groups = [...SERVICE.getGroups(sort)];
    // The service will return pre-sorted groups for alphanumeric and position. If this node has a
    // custom sort, then we need to sort it manually.
    if (customAlphabet?.length) {
      groups.sort((a, b) => {
        let aIndex = -1;
        let bIndex = -1;
        // Loop and find indexes. As we're finding multiple, a single for loop is more efficient.
        for (const [index, alpha] of customAlphabet!.entries()) {
          aIndex =
            aIndex < 0 ? (a.title.toLocaleLowerCase().startsWith(alpha) ? index : -1) : aIndex;
          bIndex =
            bIndex < 0 ? (b.title.toLocaleLowerCase().startsWith(alpha) ? index : -1) : bIndex;
          if (aIndex > -1 && bIndex > -1) {
            break;
          }
        }
        // Now compare.
        if (aIndex > -1 && bIndex > -1) {
          const ret = aIndex - bIndex;
          if (ret === 0) {
            return a.title.localeCompare(b.title);
          }
          return ret;
        } else if (aIndex > -1) {
          return -1;
        } else if (bIndex > -1) {
          return 1;
        }
        return a.title.localeCompare(b.title);
      });
    }

    // See if we're filtering by colors, and match against the built-in keywords and actuial hex
    // values.
    let filterColors = (
      (this.properties?.[PROPERTY_MATCH_COLORS] as string)?.split(",") || []
    ).filter((c) => c.trim());
    if (filterColors.length) {
      filterColors = filterColors.map((color) => {
        color = color.trim().toLocaleLowerCase();
        if (LGraphCanvas.node_colors[color]) {
          color = LGraphCanvas.node_colors[color]!.groupcolor;
        }
        color = color.replace("#", "").toLocaleLowerCase();
        if (color.length === 3) {
          color = color.replace(/(.)(.)(.)/, "$1$1$2$2$3$3");
        }
        return `#${color}`;
      });
    }

    // Go over the groups
    let index = 0;
    for (const group of groups) {
      if (filterColors.length) {
        let groupColor = group.color.replace("#", "").trim().toLocaleLowerCase();
        if (groupColor.length === 3) {
          groupColor = groupColor.replace(/(.)(.)(.)/, "$1$1$2$2$3$3");
        }
        groupColor = `#${groupColor}`;
        if (!filterColors.includes(groupColor)) {
          continue;
        }
      }
      if (this.properties?.[PROPERTY_MATCH_TITLE]?.trim()) {
        try {
          if (!new RegExp(this.properties[PROPERTY_MATCH_TITLE], "i").exec(group.title)) {
            continue;
          }
        } catch (e) {
          console.error(e);
          continue;
        }
      }
      this.widgets = this.widgets || [];
      const widgetName = `Enable ${group.title}`;
      let widget = this.widgets.find((w) => w.name === widgetName);
      if (!widget) {
        // When we add a widget, litegraph is going to mess up the size, so we
        // store it so we can retrieve it in computeSize. Hacky..
        this.tempSize = [...this.size];
        widget = this.addCustomWidget<IWidget<boolean>>({
          name: "RGTHREE_TOGGLE_AND_NAV",
          label: "",
          value: false,
          disabled: false,
          options: { on: "yes", off: "no" },
          draw: function (
            ctx: CanvasRenderingContext2D,
            node: LGraphNode,
            width: number,
            posY: number,
            height: number,
          ) {
            let margin = 15;
            let outline_color = LiteGraph.WIDGET_OUTLINE_COLOR;
            let background_color = LiteGraph.WIDGET_BGCOLOR;
            let text_color = LiteGraph.WIDGET_TEXT_COLOR;
            let secondary_text_color = LiteGraph.WIDGET_SECONDARY_TEXT_COLOR;
            const showNav = node.properties?.[PROPERTY_SHOW_NAV] !== false;

            // Draw background.
            ctx.strokeStyle = outline_color;
            ctx.fillStyle = background_color;
            ctx.beginPath();
            ctx.roundRect(margin, posY, width - margin * 2, height, [height * 0.5]);
            ctx.fill();
            ctx.stroke();

            // Render from right to left, since the text on left will take available space.
            // `currentX` markes the current x position moving backwards.
            let currentX = width - margin;

            // The nav arrow
            if (showNav) {
              currentX -= 7; // Arrow space margin
              const midY = posY + height * 0.5;
              ctx.fillStyle = ctx.strokeStyle = "#89A";
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              const arrow = new Path2D(`M${currentX} ${midY} l -7 6 v -3 h -7 v -6 h 7 v -3 z`);
              ctx.fill(arrow);
              ctx.stroke(arrow);
              currentX -= 14;

              currentX -= 7;
              ctx.strokeStyle = outline_color;
              ctx.stroke(new Path2D(`M ${currentX} ${posY} v ${height}`));
            }

            // The toggle itself.
            currentX -= 7;
            ctx.fillStyle = this.value ? "#89A" : "#333";
            ctx.beginPath();
            const toggleRadius = height * 0.36;
            ctx.arc(currentX - toggleRadius, posY + height * 0.5, toggleRadius, 0, Math.PI * 2);
            ctx.fill();
            currentX -= toggleRadius * 2;

            currentX -= 4;
            ctx.textAlign = "right";
            ctx.fillStyle = this.value ? text_color : secondary_text_color;
            const label = this.label || this.name;
            const toggleLabelOn = this.options.on || "true";
            const toggleLabelOff = this.options.off || "false";
            ctx.fillText(
              this.value ? toggleLabelOn : toggleLabelOff,
              currentX,
              posY + height * 0.7,
            );
            currentX -= Math.max(
              ctx.measureText(toggleLabelOn).width,
              ctx.measureText(toggleLabelOff).width,
            );

            currentX -= 7;
            ctx.textAlign = "left";
            let maxLabelWidth = width - margin - 10 - (width - currentX);
            if (label != null) {
              ctx.fillText(fitString(ctx, label, maxLabelWidth), margin + 10, posY + height * 0.7);
            }
          },
          serializeValue(serializedNode: SerializedLGraphNode, widgetIndex: number) {
            return this.value;
          },
          mouse(event: PointerEvent, pos: Vector2, node: LGraphNode) {
            if (event.type == "pointerdown") {
              if (
                node.properties?.[PROPERTY_SHOW_NAV] !== false &&
                pos[0] >= node.size[0] - 15 - 28 - 1
              ) {
                // Clicked on right half with nav arrow, go to the group.
                app.canvas.centerOnNode(group);
              } else {
                this.value = !this.value;
                setTimeout(() => {
                  this.callback?.(this.value, app.canvas, node, pos, event);
                }, 20);
              }
            }
            return true;
          },
        });
        (widget as any).doModeChange = (force?: boolean) => {
          group.recomputeInsideNodes();
          const hasAnyActiveNodes = group._nodes.some((n) => n.mode === LiteGraph.ALWAYS);
          let newValue = force != null ? force : !hasAnyActiveNodes;
          for (const node of group._nodes) {
            node.mode = (newValue ? this.modeOn : this.modeOff) as 1 | 2 | 3 | 4;
          }
          (group as any)._rgthreeHasAnyActiveNode = newValue;
          widget!.value = newValue;
          app.graph.setDirtyCanvas(true, false);
        };
        widget.callback = () => {
          (widget as any).doModeChange();
        };

        this.setSize(this.computeSize());
      }
      if (widget.name != widgetName) {
        widget.name = widgetName;
        this.setDirtyCanvas(true, false);
      }
      if (widget.value != (group as any)._rgthreeHasAnyActiveNode) {
        widget.value = (group as any)._rgthreeHasAnyActiveNode;
        this.setDirtyCanvas(true, false);
      }
      if (this.widgets[index] !== widget) {
        const oldIndex = this.widgets.findIndex((w) => w === widget);
        this.widgets.splice(index, 0, this.widgets.splice(oldIndex, 1)[0]!);
        this.setDirtyCanvas(true, false);
      }
      index++;
    }

    // Everything should now be in order, so let's remove all remaining widgets.
    while ((this.widgets || [])[index]) {
      this.removeWidget(index++);
    }
  }

  override computeSize(out?: Vector2) {
    let size = super.computeSize(out);
    if (this.tempSize) {
      size[0] = Math.max(this.tempSize[0], size[0]);
      size[1] = Math.max(this.tempSize[1], size[1]);
      // We sometimes get repeated calls to compute size, so debounce before clearing.
      this.debouncerTempWidth && clearTimeout(this.debouncerTempWidth);
      this.debouncerTempWidth = setTimeout(() => {
        this.tempSize = null;
      }, 32);
    }
    setTimeout(() => {
      app.graph.setDirtyCanvas(true, true);
    }, 16);
    return size;
  }

  override async handleAction(action: string) {
    if (action === "Mute all") {
      for (const widget of this.widgets) {
        (widget as any)?.doModeChange(false);
      }
    } else if (action === "Enable all") {
      for (const widget of this.widgets) {
        (widget as any)?.doModeChange(true);
      }
    }
  }

  override getHelp() {
    return `
      <p>The ${this.type!.replace(
        "(rgthree)",
        "",
      )} is an input-less node that automatically collects all groups in your current
      workflow and allows you to quickly ${
        (this as FastGroupsMuter).helpActions
      } all nodes within the group.</p>
      <ul>
        <li>
          <p>
            <strong>Properties.</strong> You can change the following properties (by right-clicking
            on the node, and select "Properties" or "Properties Panel" from the menu):
          </p>
          <ul>
            <li><p>
              <code>${PROPERTY_MATCH_COLORS}</code> - Only add groups that match the provided
              colors. Can be ComfyUI colors (red, pale_blue) or hex codes (#a4d399). Multiple can be
              added, comma delimited.
            </p></li>
            <li><p>
              <code>${PROPERTY_MATCH_TITLE}</code> - Filter the list of toggles by title match
              (string match, or regular expression).
            </p></li>
            <li><p>
              <code>${PROPERTY_SHOW_NAV}</code> - Add / remove a quick navigation arrow to take you
              to the group. <i>(default: true)</i>
              </p></li>
            <li><p>
              <code>${PROPERTY_SORT}</code> - Sort the toggles' order by "alphanumeric", graph
              "position", or "custom alphabet". <i>(default: "position")</i>
            </p></li>
            <li>
              <p>
                <code>${PROPERTY_SORT_CUSTOM_ALPHA}</code> - When the
                <code>${PROPERTY_SORT}</code> property is "custom alphabet" you can define the
                alphabet to use here, which will match the <i>beginning</i> of each group name and
                sort against it. If group titles do not match any custom alphabet entry, then they
                will be put after groups that do, ordered alphanumerically.
              </p>
              <p>
                This can be a list of single characters, like "zyxw..." or comma delimited strings
                for more control, like "sdxl,pro,sd,n,p".
              </p>
              <p>
                Note, when two group title match the same custom alphabet entry, the <i>normal
                alphanumeric alphabet</i> breaks the tie. For instance, a custom alphabet of
                "e,s,d" will order groups names like "SDXL, SEGS, Detailer" eventhough the custom
                alphabet has an "e" before "d" (where one may expect "SE" to be before "SD").
              </p>
              <p>
                To have "SEGS" appear before "SDXL" you can use longer strings. For instance, the
                custom alphabet value of "se,s,f" would work here.
              </p>
            </li>

          </ul>
        </li>
      </ul>`;
  }

  static override setUp<T extends RgthreeBaseNode>(clazz: new (title?: string) => T) {
    LiteGraph.registerNodeType((clazz as any).type, clazz);
    (clazz as any).category = (clazz as any)._category;
  }
}

app.registerExtension({
  name: "rgthree.FastGroupsMuter",
  registerCustomNodes() {
    FastGroupsMuter.setUp(FastGroupsMuter);
  },
  loadedGraphNode(node: LGraphNode) {
    if (node.type == FastGroupsMuter.title) {
      (node as FastGroupsMuter).tempSize = [...node.size];
    }
  },
});
