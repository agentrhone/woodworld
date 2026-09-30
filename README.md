# Wood World

You start in a small clearing in the middle of a huge forest. All you have is a pocket knife. Chop down trees to make the clearing bigger, collect wood, and use it to build and craft better tools so you can cut down bigger trees.

## Play

Open `index.html` in a browser. You don't need to build or install anything.

To serve it locally instead:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Controls

| Action | Keyboard | Mouse / touch |
| --- | --- | --- |
| Move | WASD / arrow keys | Click or tap an open tile |
| Chop | Hold Space near a tree | Click or tap a tree (you walk over and chop it) |
| Build | Pick a building in the Build panel, then click a cleared tile | Same |
| Cancel building | Esc | Tap the building button again |
| Zoom | Mouse wheel | — |

The game saves itself to your browser's local storage every few seconds.

## How it works

**Trees get bigger the deeper you go.** Only saplings grow at the edge of the clearing. Further out the trees get bigger, and each size needs a better tool:

| Tree | HP | Wood | Needs |
| --- | --- | --- | --- |
| Sapling | 3 | 1 | Pocket Knife |
| Young Birch | 8 | 3 | Hatchet |
| Pine | 24 | 8 | Axe |
| Oak | 70 | 22 | Felling Axe |
| Old Fir | 180 | 55 | Crosscut Saw |
| Ancient Redwood | 500 | 160 | Chainsaw |

**Tools**, crafted from the panel:

| Tool | Cost | Requires |
| --- | --- | --- |
| Hatchet | 15 | — |
| Axe | 60 | Workbench |
| Felling Axe | 180 | Workbench |
| Crosscut Saw | 450 | Sawmill |
| Chainsaw | 1200 | Sawmill |

**Buildings** go on cleared tiles, so you need open space to grow:

| Building | Cost | Effect |
| --- | --- | --- |
| Workbench | 10 | Unlocks the Axe and Felling Axe |
| Woodshed | 20 | +100 wood storage (you start with 25) |
| Cabin | 80 | A lumberjack moves in and chops trees for you |
| Sawmill | 150 | +50% wood per tree, unlocks the saws |
| Lumber Yard | 300 | +600 wood storage |

Lumberjacks use a tool one tier below yours (at least a Hatchet), so they get better when you do.

## Code layout

- `index.html`: page shell and HUD
- `style.css`: HUD and panel styling
- `game.js`: world generation, movement and pathfinding, chopping, building, helpers, rendering, and saving

## Ideas for later

- Saplings slowly growing back at the forest edge, so you have to keep up
- Rocks, rivers, or clearings found deep in the woods
- Bigger buildings that take up more than one tile, and paths or fences
- Sound effects and a day/night cycle
