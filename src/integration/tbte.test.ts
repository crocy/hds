/**
 * End-to-end check against the TBTE housing in the repo root.
 *
 * This is the only test that exercises the real chain — STEP tessellation,
 * welding, topology, cavity detection, contacts, solve — against a model whose
 * answer is already known from a trusted prior run (thermal_field.png):
 * ≈61 W total loss to ambient and a fin length λ ≈ 46 mm.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { importStep, createOcctModule } from '../geometry/importers/step';
import { buildThermalModel } from '../geometry/build';
import { detectCavities, setCavityCondition } from '../geometry/cavity';
import { detectContacts } from '../geometry/contacts';
import { solveShell } from '../physics/solve';
import { resolveTargetNodes } from '../physics/assemble';
import { analysePathLength } from '../analysis/pathLength';
import { createDefaultScenario } from '../core/defaults';
import { celsiusToKelvin, kelvinToCelsius } from '../core/units';

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve('occt-import-js/dist/occt-import-js.wasm');
const STEP_PATH = fileURLToPath(new URL('../../ohisje - TBTE 2x116.step', import.meta.url));

async function loadTbte() {
  const occt = await createOcctModule({
    locateFile: (file) => (file.endsWith('.wasm') ? WASM_PATH : file),
  });
  const mesh = await importStep(readFileSync(STEP_PATH), { occt });
  return buildThermalModel(mesh);
}

describe('TBTE housing', () => {
  it('imports as a named 7-part assembly', async () => {
    const model = await loadTbte();

    const names = model.parts.map((p) => p.name).sort();
    console.log('parts:', model.parts.map((p) => `${p.name} (${p.bodyType})`).join(', '));
    console.log('nodes:', model.nodeCount, 'tris:', model.triCount);
    console.log(
      'bbox mm:',
      model.bbox.min.map((v) => (v * 1000).toFixed(1)).join(', '),
      '->',
      model.bbox.max.map((v) => (v * 1000).toFixed(1)).join(', '),
    );
    for (const part of model.parts) {
      console.log(
        `  ${part.name}: area ${(part.surfaceArea * 1e4).toFixed(1)} cm2,` +
          ` vol ${(part.volume * 1e9).toFixed(0)} mm3,` +
          ` thinness ${part.thinnessRatio.toFixed(3)} -> ${part.bodyType},` +
          ` faces ${new Set(Array.from({ length: part.triRange[1] - part.triRange[0] }, (_, i) => model.triFace[part.triRange[0] + i])).size}`,
      );
    }

    expect(names).toEqual([
      'bezel_48x48',
      'dno',
      'glava',
      'housing',
      'mounting_clip_keepout',
      'ohisje',
      'terminal_block',
    ]);
    expect(model.triCount).toBeGreaterThan(1000);
    // Welding must actually have collapsed the seam duplicates.
    expect(model.nodeCount).toBeLessThan(model.triCount * 3);
  }, 120_000);

  it('solves the reference scenario', async () => {
    const model = await loadTbte();
    const scenario = createDefaultScenario(20);

    const cavityResult = detectCavities(model);
    scenario.cavities = cavityResult.cavities.map((c) => setCavityCondition(c, 'insulated'));
    scenario.contacts = detectContacts(model);
    console.log(
      'cavities:',
      scenario.cavities.map((c) => `${c.name} (${c.triCount} tris)`).join(', ') || 'none',
    );
    console.log(
      'contacts:',
      scenario.contacts
        .map((c) => `${c.partA}-${c.partB} (${c.nodePairs.length / 2} pairs)`)
        .join(', ') || 'none',
    );

    // 1 mm SS304 everywhere, bare finish, matching the reference run's caption.
    for (const part of model.parts) {
      scenario.partOverrides[part.id] = { thickness: 0.001 };
    }

    // The reference holds the aluminium block's rim at 200 C. The block is a lump,
    // so pinning the part is equivalent to pinning its rim.
    const block = model.parts.find((p) => p.name === 'housing');
    expect(block).toBeDefined();
    scenario.boundaryConditions = [
      {
        id: 'block-200c',
        kind: 'fixedTemp',
        target: { type: 'part', partId: block!.id },
        value: celsiusToKelvin(200),
        enabled: true,
      },
    ];

    const result = solveShell(model, scenario);
    const sourceNodes = resolveTargetNodes(model, { type: 'part', partId: block!.id });
    const path = analysePathLength(model, sourceNodes, result.temperature, {
      contacts: scenario.contacts,
      tInfinity: scenario.ambient,
    });

    console.log(
      `converged=${result.converged} iters=${result.outerIterations} ${result.elapsedMs.toFixed(0)}ms`,
    );
    console.log(
      `T range: ${kelvinToCelsius(result.minTemp).toFixed(1)} .. ${kelvinToCelsius(result.maxTemp).toFixed(1)} C`,
    );
    console.log(
      `loss: convection ${result.balance.lostByConvection.toFixed(2)} W +` +
        ` radiation ${result.balance.lostByRadiation.toFixed(2)} W =` +
        ` ${(result.balance.lostByConvection + result.balance.lostByRadiation).toFixed(2)} W`,
    );
    console.log(`injected: ${result.balance.injectedAtFixed.toFixed(2)} W`);
    console.log(`residual: ${result.balance.residual.toExponential(2)} W`);
    console.log(
      `fin length lambda: ${path.fit ? (path.fit.lambda * 1000).toFixed(1) + ' mm' : 'no fit'}` +
        `${path.fit ? ` (r2 ${path.fit.rSquared.toFixed(3)})` : ''}`,
    );
    if (result.warnings.length) console.log('warnings:', result.warnings.join(' | '));

    expect(result.converged).toBe(true);
    expect(result.temperature.some(Number.isNaN)).toBe(false);
    expect(kelvinToCelsius(result.maxTemp)).toBeCloseTo(200, 0);
    // Everything must sit between ambient and the driven temperature.
    expect(kelvinToCelsius(result.minTemp)).toBeGreaterThanOrEqual(19.9);
  }, 120_000);
});
