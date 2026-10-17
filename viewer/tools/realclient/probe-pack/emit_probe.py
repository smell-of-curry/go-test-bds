#!/usr/bin/env python3
"""One-shot emitter for ui/probe.json.

Cells A–L stay in the left 480×270. Cell M sits in the right half
(x >= 490) of the 960×540 scale-2 screen.
"""

from __future__ import annotations

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent / "ui" / "probe.json"

TEX_SOLID = "textures/probe/solid"
TEX_CHECK = "textures/probe/checker16x32"
TEX_GRAD = "textures/probe/grad"
TEX_NINE = "textures/probe/nine"
TEX_BLACK = "textures/probe/black"
TEX_RING = "textures/probe/ring"

CELLS: dict[str, tuple[int, int, int, int]] = {
    # 4,4 origin. Exact 60px specimens where they fit; D is two 80-wide
    # columns; I is a full-width band so the long labels have a line.
    "cell_a": (4, 4, 188, 44),
    "cell_e": (196, 4, 180, 46),
    "cell_h": (380, 4, 96, 72),
    "cell_b": (4, 52, 188, 74),
    "cell_c": (196, 52, 128, 74),
    "cell_g": (328, 52, 48, 46),
    "cell_d": (4, 130, 188, 92),
    "cell_f": (196, 130, 128, 72),
    "cell_j": (328, 104, 148, 52),
    "cell_k": (328, 160, 148, 62),
    "cell_l": (4, 224, 120, 44),
    "cell_i": (128, 224, 348, 44),
    # Right half of a 960×540 scale-2 screen. Do not move A–L.
    "cell_m1": (496, 4, 40, 42),
    "cell_m2": (540, 4, 40, 42),
    "cell_m3": (584, 4, 40, 42),
    "cell_m4": (628, 4, 40, 42),
    "cell_m5": (672, 4, 40, 42),
    "cell_m6": (716, 4, 40, 42),
    "cell_m9": (760, 4, 40, 42),
    "cell_m7": (496, 52, 70, 72),
    "cell_m8": (572, 52, 70, 72),
}


def check_layout() -> None:
    rects = []
    for name, (x, y, w, h) in CELLS.items():
        if name.startswith("cell_m"):
            if x < 490 or y < 0 or x + w > 960 or y + h > 540:
                raise SystemExit(f"oob {name} {(x, y, w, h)}")
        elif x < 0 or y < 0 or x + w > 480 or y + h > 270:
            raise SystemExit(f"oob {name} {(x, y, w, h)}")
        rects.append((name, x, y, x + w, y + h))
    for i, a in enumerate(rects):
        for b in rects[i + 1 :]:
            if a[3] <= b[1] or b[3] <= a[1] or a[4] <= b[2] or b[4] <= a[2]:
                continue
            raise SystemExit(f"overlap {a[0]} {b[0]}")


def tl(el: dict) -> dict:
    el.setdefault("anchor_from", "top_left")
    el.setdefault("anchor_to", "top_left")
    return el


def label(text: str, **props: object) -> dict:
    el: dict = {
        "type": "label",
        "text": text,
        "shadow": False,
        "color": [1, 1, 1],
    }
    el.update(props)
    return tl(el)


def image(**props: object) -> dict:
    el: dict = {"type": "image", "texture": TEX_SOLID}
    el.update(props)
    return tl(el)


def panel(**props: object) -> dict:
    el: dict = {"type": "panel"}
    el.update(props)
    return tl(el)


def ctrl(name: str, el: dict) -> dict:
    return {name: el}


def solid(color: list[float], size: list, **props: object) -> dict:
    return image(color=color, size=size, **props)


def cell(name: str, title: str, controls: list) -> dict:
    x, y, w, h = CELLS[name]
    body = [ctrl("title", label(title, size=["100%", 8], offset=[0, 0]))]
    body.extend(controls)
    return panel(
        offset=[x, y],
        size=[w, h],
        layer=1,
        controls=body,
    )


def cell_a() -> dict:
    boxes = []
    specs = [(False, "keep_false"), (True, "keep_true"), (None, "keep_omit")]
    for i, (flag, name) in enumerate(specs):
        props: dict = {
            "texture": TEX_CHECK,
            "size": [60, 30],
            "offset": [i * 64, 10],
        }
        if flag is not None:
            props["keep_ratio"] = flag
        boxes.append(ctrl(name, image(**props)))
    return cell("cell_a", "A keep false | true | omit", boxes)


def cell_b() -> dict:
    out = []
    offsets = [["50%", 0], ["50%x", 0], ["50%c", 0]]
    names = ["off_pct", "off_x", "off_c"]
    for i, (off, name) in enumerate(zip(offsets, names)):
        out.append(
            ctrl(
                name,
                solid(
                    [0.3, 0.3, 0.3],
                    [60, 60],
                    offset=[i * 64, 12],
                    controls=[
                        ctrl(
                            "mark",
                            solid(
                                [1, 0, 0],
                                [10, 10],
                                offset=off,
                            ),
                        )
                    ],
                ),
            )
        )
    return cell("cell_b", "B 50% | 50%x | 50%c", out)


def grey_host(name: str, offset: list, center: bool) -> dict:
    host: dict = {
        "type": "panel",
        "controls": [
            ctrl(
                "mark",
                solid(
                    [0, 0.85, 0.2],
                    [10, 10],
                    anchor_from="bottom_right",
                    anchor_to="bottom_right",
                ),
            )
        ],
    }
    if center:
        host["anchor_from"] = "center"
        host["anchor_to"] = "center"
    return ctrl(
        name,
        solid(
            [0.3, 0.3, 0.3],
            [60, 60],
            offset=offset,
            controls=[ctrl("host", host)],
        ),
    )


def cell_c() -> dict:
    return cell(
        "cell_c",
        "C default | center",
        [
            grey_host("fillish", [0, 12], False),
            grey_host("centered", [64, 12], True),
        ],
    )


def cell_d() -> dict:
    def parent(name: str, offset: list, child: dict, ph: int = 40) -> dict:
        return ctrl(
            name,
            solid(
                [0.22, 0.22, 0.22],
                [80, ph],
                offset=offset,
                controls=[child],
            ),
        )

    return cell(
        "cell_d",
        "D % | %y | %c | fill | +5 | -10",
        [
            parent(
                "p_pct",
                [0, 8],
                ctrl(
                    "img",
                    image(texture=TEX_CHECK, size=["50%", "100%"]),
                ),
            ),
            parent(
                "p_y",
                [84, 8],
                ctrl(
                    "img",
                    image(texture=TEX_CHECK, size=["50%y", "100%"]),
                ),
            ),
            parent(
                "p_c",
                [0, 50],
                ctrl(
                    "img",
                    solid(
                        [0, 0.75, 0.3],
                        ["100%c", 16],
                        controls=[
                            ctrl(
                                "chip",
                                solid([1, 0.2, 0.2], [24, 10]),
                            )
                        ],
                    ),
                ),
            ),
            ctrl(
                "p_math",
                solid(
                    [0.22, 0.22, 0.22],
                    [80, 40],
                    offset=[84, 50],
                    controls=[
                        ctrl(
                            "stack",
                            {
                                "type": "stack_panel",
                                "orientation": "horizontal",
                                "size": [80, 12],
                                "anchor_from": "top_left",
                                "anchor_to": "top_left",
                                "controls": [
                                    ctrl(
                                        "fixed",
                                        solid([0.9, 0.15, 0.15], [20, 10]),
                                    ),
                                    ctrl(
                                        "fill",
                                        solid([0.15, 0.75, 0.25], ["fill", 10]),
                                    ),
                                ],
                            },
                        ),
                        ctrl(
                            "plus",
                            solid(
                                [0.95, 0.75, 0.15],
                                ["50% + 5px", 8],
                                offset=[0, 14],
                            ),
                        ),
                        ctrl(
                            "minus",
                            solid(
                                [0.25, 0.55, 1],
                                ["100% - 10px", 8],
                                offset=[0, 26],
                            ),
                        ),
                    ],
                ),
            ),
        ],
    )


def cell_e() -> dict:
    specs = [
        ("raw", {}),
        ("red", {"color": [1, 0, 0]}),
        ("blue", {"color": [0.5, 0.5, 1.0]}),
        ("half", {"alpha": 0.5}),
        ("solid_tint", {"texture": TEX_SOLID, "color": [0.25, 0.6, 1.0]}),
    ]
    controls = []
    for i, (name, extra) in enumerate(specs):
        props = {"texture": TEX_GRAD, "size": [32, 32], "offset": [i * 34, 10]}
        props.update(extra)
        controls.append(ctrl(name, image(**props)))
    return cell("cell_e", "E tint", controls)


def cell_f() -> dict:
    return cell(
        "cell_f",
        "F nine 1 / stretch",
        [
            ctrl(
                "native",
                image(texture=TEX_NINE, size=[12, 12], offset=[0, 10]),
            ),
            ctrl(
                "wide",
                image(texture=TEX_NINE, size=[48, 24], offset=[16, 10]),
            ),
            ctrl(
                "tall",
                image(texture=TEX_NINE, size=[30, 60], offset=[68, 10]),
            ),
            ctrl(
                "forced",
                image(
                    texture=TEX_NINE,
                    size=[24, 24],
                    offset=[16, 38],
                    nineslice_size=1,
                ),
            ),
        ],
    )


def cell_g() -> dict:
    return cell(
        "cell_g",
        "G uv",
        [
            ctrl(
                "tl",
                image(
                    texture=TEX_CHECK,
                    size=[16, 16],
                    offset=[0, 10],
                    uv=[0, 0],
                    uv_size=[8, 8],
                ),
            ),
            ctrl(
                "br",
                image(
                    texture=TEX_CHECK,
                    size=[16, 32],
                    offset=[20, 10],
                    uv=[8, 16],
                    uv_size=[8, 16],
                ),
            ),
        ],
    )


def trio(prefix: str, origin: list[int], layers: list[int]) -> list:
    colors = [[1, 0, 0], [0, 0.8, 0.2], [0.2, 0.4, 1]]
    names = ["r", "g", "b"]
    out = []
    for i, (col, layer, name) in enumerate(zip(colors, layers, names)):
        out.append(
            ctrl(
                f"{prefix}_{name}",
                solid(
                    col,
                    [20, 20],
                    offset=[origin[0] + i * 6, origin[1] + i * 6],
                    layer=layer,
                ),
            )
        )
    return out


def cell_h() -> dict:
    controls = []
    controls.extend(trio("same", [0, 10], [0, 0, 0]))
    controls.extend(trio("ord", [40, 10], [2, 1, 0]))
    controls.append(
        ctrl(
            "nest",
            panel(
                layer=5,
                size=[24, 24],
                offset=[0, 42],
                controls=[
                    ctrl(
                        "kid",
                        solid(
                            [0, 0.9, 0.4],
                            [20, 20],
                            layer=-10,
                        ),
                    )
                ],
            ),
        )
    )
    controls.append(
        ctrl(
            "sib",
            solid([1, 0.2, 0.2], [20, 20], layer=1, offset=[10, 50]),
        )
    )
    return cell("cell_h", "H layer", controls)


FOX = "The quick brown fox 0123456789"


def cell_i() -> dict:
    # 336-wide band beside L. Fixed boxes so each variant is a separate
    # rectangle even when the sentence is wider than the box.
    controls = [
        ctrl("def", label(FOX, size=[156, 8], offset=[0, 8])),
        ctrl("sh", label(FOX, shadow=True, size=[156, 8], offset=[0, 16])),
        ctrl(
            "col",
            label(FOX, color=[1, 0.33, 0.33], size=[156, 8], offset=[0, 24]),
        ),
        ctrl(
            "codes",
            label("§aGreen §lBold§r §oItalic", size=[156, 8], offset=[0, 32]),
        ),
        ctrl(
            "scale",
            label(FOX, font_scale_factor=2, size=[180, 12], offset=[164, 8]),
        ),
        ctrl(
            "large",
            label(FOX, font_size="large", size=[80, 8], offset=[164, 20]),
        ),
        ctrl(
            "small",
            label(FOX, font_size="small", size=[36, 8], offset=[248, 20]),
        ),
        ctrl(
            "center",
            label(
                FOX,
                text_alignment="center",
                size=[120, 8],
                offset=[164, 28],
            ),
        ),
        ctrl(
            "right",
            label(
                FOX,
                text_alignment="right",
                size=[120, 8],
                offset=[164, 36],
            ),
        ),
        ctrl(
            "wrap_max",
            label(FOX, max_width=60, size=[60, 12], offset=[288, 20]),
        ),
        ctrl(
            "wrap_box",
            label(FOX, size=[60, 14], offset=[288, 30]),
        ),
    ]
    return cell("cell_i", "I labels", controls)


def cell_j() -> dict:
    def host(name: str, offset: list, propagate: bool | None) -> dict:
        props: dict = {
            "alpha": 0.5,
            "color": [1, 1, 1],
            "size": [40, 40],
            "offset": offset,
            "controls": [
                ctrl(
                    "kid",
                    solid([1, 0, 0], [16, 16], offset=[8, 8], alpha=1),
                )
            ],
        }
        if propagate is not None:
            props["propagate_alpha"] = propagate
        return ctrl(name, image(**props))

    return cell(
        "cell_j",
        "J alpha | propagate",
        [host("plain", [0, 10], None), host("prop", [48, 10], True)],
    )


def clip_case(name: str, offset: list, clips: bool) -> dict:
    return ctrl(
        name,
        panel(
            size=[30, 30],
            offset=offset,
            clips_children=clips,
            controls=[
                ctrl("frame", solid([0.35, 0.35, 0.35], [30, 30])),
                ctrl(
                    "big",
                    image(
                        texture=TEX_CHECK,
                        size=[50, 50],
                        offset=[-10, -10],
                    ),
                ),
            ],
        ),
    )


def cell_k() -> dict:
    return cell(
        "cell_k",
        "K clips on | off",
        [
            clip_case("on", [12, 18], True),
            clip_case("off", [78, 18], False),
        ],
    )


def solids_row(sizes: list[tuple[int, int]], colors: list[list[float]]) -> list:
    controls = []
    for i, ((w, h), col) in enumerate(zip(sizes, colors)):
        controls.append(ctrl(f"s{i}", solid(col, [w, h])))
    return controls


def cell_l() -> dict:
    colors = [[1, 0.2, 0.2], [0.2, 0.85, 0.3], [0.25, 0.45, 1]]
    sizes = [(10, 10), (15, 10), (20, 10)]
    return cell(
        "cell_l",
        "L stack",
        [
            ctrl(
                "v",
                {
                    "type": "stack_panel",
                    "orientation": "vertical",
                    "anchor_from": "top_left",
                    "anchor_to": "top_left",
                    "offset": [0, 8],
                    "size": ["100%c", "100%c"],
                    "controls": solids_row(sizes, colors),
                },
            ),
            ctrl(
                "h",
                {
                    "type": "stack_panel",
                    "orientation": "horizontal",
                    "anchor_from": "top_left",
                    "anchor_to": "top_left",
                    "offset": [28, 8],
                    "size": ["100%c", "100%c"],
                    "controls": solids_row(sizes, colors),
                },
            ),
            ctrl(
                "c",
                {
                    "type": "stack_panel",
                    "orientation": "horizontal",
                    "anchor_from": "top_left",
                    "anchor_to": "top_left",
                    "offset": [80, 8],
                    "size": [40, 14],
                    "controls": [
                        ctrl(
                            "grow",
                            panel(
                                size=["100%c", 10],
                                controls=[
                                    ctrl("chip", solid([1, 0.85, 0.2], [16, 8]))
                                ],
                            ),
                        )
                    ],
                },
            ),
        ],
    )


def k_off(checker_first: bool) -> dict:
    frame = ctrl("frame", solid([0.35, 0.35, 0.35], [30, 30], keep_ratio=False))
    big = ctrl(
        "big",
        image(
            texture=TEX_CHECK,
            size=[50, 50],
            offset=[-10, -10],
            keep_ratio=False,
        ),
    )
    controls = [big, frame] if checker_first else [frame, big]
    return ctrl(
        "off",
        panel(
            size=[30, 30],
            offset=[12, 18],
            clips_children=False,
            controls=controls,
        ),
    )


RED = [1, 0, 0]
BLUE = [0, 0.35, 1]


def stretch_solid(color: list[float], size: list, **props: object) -> dict:
    return solid(color, size, keep_ratio=False, **props)


def parent_child(parent_alpha: float, child_alpha: float, propagate: bool | None) -> dict:
    child = stretch_solid(BLUE, [20, 20], offset=[10, 0], alpha=child_alpha)
    props: dict = {
        "alpha": parent_alpha,
        "size": [20, 20],
        "offset": [0, 10],
        "controls": [ctrl("kid", child)],
    }
    if propagate is not None:
        props["propagate_alpha"] = propagate
    return ctrl("host", stretch_solid(RED, **props))


def sibling_pair(first_alpha: float, second_alpha: float) -> list:
    return [
        ctrl(
            "first",
            stretch_solid(RED, [20, 20], offset=[0, 10], alpha=first_alpha),
        ),
        ctrl(
            "second",
            stretch_solid(BLUE, [20, 20], offset=[10, 10], alpha=second_alpha),
        ),
    ]


def cell_m1() -> dict:
    return cell("cell_m1", "M1 p1 c1", [parent_child(1.0, 1.0, None)])


def cell_m2() -> dict:
    return cell("cell_m2", "M2 p.99 c1", [parent_child(0.99, 1.0, None)])


def cell_m3() -> dict:
    return cell("cell_m3", "M3 p1 c.5", [parent_child(1.0, 0.5, None)])


def cell_m4() -> dict:
    return cell("cell_m4", "M4 a.5 then 1", sibling_pair(0.5, 1.0))


def cell_m5() -> dict:
    return cell("cell_m5", "M5 1 then a.5", sibling_pair(1.0, 0.5))


def cell_m6() -> dict:
    return cell("cell_m6", "M6 prop a.5", [parent_child(0.5, 1.0, True)])


def cell_m7() -> dict:
    return cell("cell_m7", "M7 frame then chk", [k_off(False)])


def cell_m8() -> dict:
    return cell("cell_m8", "M8 chk then frame", [k_off(True)])


def cell_m9() -> dict:
    return cell(
        "cell_m9",
        "M9 ring then solid",
        [
            ctrl(
                "ring",
                image(
                    texture=TEX_RING,
                    size=[16, 16],
                    offset=[0, 10],
                    keep_ratio=False,
                ),
            ),
            ctrl(
                "solid",
                stretch_solid([0.15, 0.9, 0.2], [16, 16], offset=[0, 10], alpha=1),
            ),
        ],
    )


def main() -> None:
    check_layout()
    # J sits in a gap that the table must not overlap. Re-check after
    # the constants above — check_layout already covers every cell.
    elements: dict = {
        "namespace": "probe",
        "bg": image(
            texture=TEX_BLACK,
            size=["100%", "100%"],
            layer=0,
            keep_ratio=False,
        ),
        "cell_a": cell_a(),
        "cell_b": cell_b(),
        "cell_c": cell_c(),
        "cell_d": cell_d(),
        "cell_e": cell_e(),
        "cell_f": cell_f(),
        "cell_g": cell_g(),
        "cell_h": cell_h(),
        "cell_i": cell_i(),
        "cell_j": cell_j(),
        "cell_k": cell_k(),
        "cell_l": cell_l(),
        "cell_m1": cell_m1(),
        "cell_m2": cell_m2(),
        "cell_m3": cell_m3(),
        "cell_m4": cell_m4(),
        "cell_m5": cell_m5(),
        "cell_m6": cell_m6(),
        "cell_m7": cell_m7(),
        "cell_m8": cell_m8(),
        "cell_m9": cell_m9(),
    }
    elements["root"] = panel(
        size=["100%", "100%"],
        layer=0,
        controls=[ctrl("bg", {"type": "panel"})]  # placeholder replaced below
        if False
        else [],
    )
    root_controls = [ctrl("bg@probe.bg", {})]
    for name in (
        "cell_a",
        "cell_b",
        "cell_c",
        "cell_d",
        "cell_e",
        "cell_f",
        "cell_g",
        "cell_h",
        "cell_i",
        "cell_j",
        "cell_k",
        "cell_l",
        "cell_m1",
        "cell_m2",
        "cell_m3",
        "cell_m4",
        "cell_m5",
        "cell_m6",
        "cell_m7",
        "cell_m8",
        "cell_m9",
    ):
        root_controls.append(ctrl(f"{name}@probe.{name}", {}))
    elements["root"] = panel(size=["100%", "100%"], controls=root_controls)
    # namespace must be first key for readability
    doc = {"namespace": "probe"}
    for key in (
        "root",
        "bg",
        "cell_a",
        "cell_b",
        "cell_c",
        "cell_d",
        "cell_e",
        "cell_f",
        "cell_g",
        "cell_h",
        "cell_i",
        "cell_j",
        "cell_k",
        "cell_l",
        "cell_m1",
        "cell_m2",
        "cell_m3",
        "cell_m4",
        "cell_m5",
        "cell_m6",
        "cell_m7",
        "cell_m8",
        "cell_m9",
    ):
        doc[key] = elements[key]
    OUT.write_text(json.dumps(doc, indent=2) + "\n")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
