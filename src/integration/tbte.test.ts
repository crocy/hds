/**
 * End-to-end check against the TBTE housing in the repo root.
 *
 * This is the only test that exercises the real chain — STEP tessellation,
 * welding, topology, cavity detection, contacts, solve — against a model whose
 * answer is already known from a trusted prior run (thermal_field.png and
 * thermal_model_3d.html): ≈61 W total loss to ambient, 1 mm SS304, block rim at
 * 200 °C, 20 °C still air, insulated cavity.
 *
 * That run was a **mid-surface** model: its mesh carries 3194 cm² of surface, one
 * side per sheet, and no interior faces at all. Ours is the sheet solid the CAD
 * actually contains, so it carries 7734 cm² — outer skin, inner skin and edge
 * bands — and the comparable figure is the loss from the skin that faces ambient,
 * not the total. The assertions below are written against that comparison.
 *
 * The two skins are merged onto one DOF per in-plane position wherever they can be
 * paired, so the sheet conducts its full thickness in plane and is isothermal across
 * it — see `pairThroughThickness`. Without that the inner skin is a near-lossless
 * spreader that the heat from the block cannot leave, and the model reports 94.6 W
 * against the 101.5 W it reports now.
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
import { pairThroughThickness, resolveTargetNodes, surfaceCoefficients } from '../physics/assemble';
import { computeTriangleEmissivity, STEFAN_BOLTZMANN } from '../physics/radiation';
import { analysePathLength } from '../analysis/pathLength';
import { createDefaultScenario } from '../core/defaults';
import { celsiusToKelvin, kelvinToCelsius } from '../core/units';
import type { Scenario, ThermalModel } from '../core/types';

const require = createRequire(import.meta.url);
const WASM_PATH = require.resolve('occt-import-js/dist/occt-import-js.wasm');
const STEP_PATH = fileURLToPath(new URL('../../ohisje - TBTE 2x116.step', import.meta.url));

/**
 * Convection plus radiation from the triangles that face ambient — the part of the
 * model the mid-surface reference run is comparable to.
 *
 * Integrated per triangle corner, exactly as the solver assembles it and the balance
 * reports it, so this is a partition of `lostByConvection + lostByRadiation` rather
 * than a second, slightly different account of the same watts.
 */
function lossThroughOpenAir(
  model: ThermalModel,
  scenario: Scenario,
  temperature: Float32Array,
): { watts: number; area: number; meanExcess: number } {
  const coefficients = surfaceCoefficients(model, scenario, temperature);
  const emissivity = computeTriangleEmissivity(model, scenario);
  let watts = 0;
  let area = 0;
  let excessArea = 0;
  for (let t = 0; t < model.triCount; t++) {
    if (model.triCavity[t] > 0) continue;
    const share = model.triArea[t] / 3;
    let excess = 0;
    for (let corner = 0; corner < 3; corner++) {
      const node = model.tris[t * 3 + corner];
      excess += (temperature[node] - scenario.ambient) / 3;
      watts +=
        coefficients.hConv[t] * share * (temperature[node] - scenario.ambient) +
        emissivity[t] * STEFAN_BOLTZMANN * share * (temperature[node] ** 4 - scenario.ambient ** 4);
    }
    area += model.triArea[t];
    excessArea += model.triArea[t] * excess;
  }
  return { watts, area, meanExcess: excessArea / area };
}

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
          ` thickness ${(part.thickness * 1000).toFixed(3)} mm,` +
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

    // The three sheet-metal parts are drawn from 1 mm sheet, and import has to read
    // that back off their volume rather than making the user type it.
    for (const name of ['ohisje', 'glava', 'dno']) {
      const part = model.parts.find((p) => p.name === name);
      expect(part?.thickness).toBeCloseTo(0.001, 4);
    }
  }, 120_000);

  it('solves the reference scenario', async () => {
    const model = await loadTbte();
    const scenario = createDefaultScenario(20);

    const cavityResult = detectCavities(model);
    scenario.cavities = cavityResult.cavities.map((c) => setCavityCondition(c, 'insulated'));
    scenario.contacts = detectContacts(model);
    let enclosedArea = 0;
    let totalArea = 0;
    for (let t = 0; t < model.triCount; t++) {
      totalArea += model.triArea[t];
      if (model.triCavity[t] > 0) enclosedArea += model.triArea[t];
    }
    console.log(
      `cavities: ${scenario.cavities.length}, enclosed area` +
        ` ${((100 * enclosedArea) / totalArea).toFixed(1)}% of ${(totalArea * 1e4).toFixed(0)} cm2`,
    );
    console.log(
      '  ',
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

    // A sheet solid's mesh carries both faces, and a 1 mm steel sheet is isothermal
    // through its thickness (Bi = h·t/k ≈ 5e-4), so the two skins have to share a DOF.
    // Edge bands, holes and the two parts whose walls are not 1 mm never pair, and are
    // left as two half-thickness shells joined at their rims.
    const opposite = pairThroughThickness(model, scenario);
    let pairableNodes = 0;
    let pairedNodes = 0;
    for (const part of model.parts) {
      if (part.bodyType !== 'sheet' || part.volume === 0) continue;
      for (let node = part.nodeRange[0]; node < part.nodeRange[1]; node++) {
        pairableNodes++;
        if (opposite[node] >= 0) pairedNodes++;
      }
    }
    console.log(
      `through-thickness pairs: ${pairedNodes}/${pairableNodes} sheet-solid nodes` +
        ` (${((100 * pairedNodes) / pairableNodes).toFixed(1)}%)`,
    );

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

    const exposed = lossThroughOpenAir(model, scenario, result.temperature);
    console.log(
      `open air: ${exposed.watts.toFixed(2)} W over ${(exposed.area * 1e4).toFixed(0)} cm2` +
        ` at a mean excess of ${exposed.meanExcess.toFixed(1)} K` +
        ` (reference: 61 W over 3194 cm2 at 22.9 K)`,
    );
    if (result.warnings.length) console.log('warnings:', result.warnings.join(' | '));

    expect(result.converged).toBe(true);
    expect(result.temperature.some(Number.isNaN)).toBe(false);
    expect(kelvinToCelsius(result.maxTemp)).toBeCloseTo(200, 0);
    // Everything must sit between ambient and the driven temperature.
    expect(kelvinToCelsius(result.minTemp)).toBeGreaterThanOrEqual(19.9);

    // Most of a real housing's skin pairs; the rest — edge bands, hole rims, the two
    // parts whose walls are not the 1 mm this scenario declares — does not, and must
    // not, because pairing through a wall that is not there would invent a sheet.
    // Measured: 2858 of 4123 (69.3 %).
    expect(pairedNodes / pairableNodes).toBeGreaterThan(0.6);
    for (let node = 0; node < model.nodeCount; node++) {
      const twin = opposite[node];
      // One DOF means one temperature, bit for bit — not merely a small gradient.
      if (twin >= 0) expect(result.temperature[node]).toBe(result.temperature[twin]);
    }

    // Cavity detection has to find the inside of a sealed housing: inner skin, edge
    // bands and the parts buried in it are the majority of a sheet solid's area.
    expect(enclosedArea / totalArea).toBeGreaterThan(0.5);
    expect(enclosedArea / totalArea).toBeLessThan(0.7);
    // What is left is the skin that faces ambient, and it should match the whole of
    // the reference model's mid-surface mesh — 3194 cm² — because that is the same
    // surface. This is the structural cross-check on the cavity classification.
    const REFERENCE_MESH_AREA = 0.3194;
    expect(totalArea - enclosedArea).toBeGreaterThan(REFERENCE_MESH_AREA * 0.9);
    expect(totalArea - enclosedArea).toBeLessThan(REFERENCE_MESH_AREA * 1.1);

    // ...and the heat leaving that skin should match the reference's 61 W. Measured
    // 64.8 W. The total is higher (~102 W) because our cavity-facing skin exists and
    // the reference's does not: at the default 'insulated' condition it sheds another
    // ~37 W that the reference model structurally cannot.
    expect(exposed.watts).toBeGreaterThan(50);
    expect(exposed.watts).toBeLessThan(72);

    // This is the model the residual has to be watched on, because it is the one with
    // PERFECT_CONTACT joints on a pinned part: eliminating that pin folds conductance ×
    // 473 K into its neighbours' rows and inflates ‖b‖ by ~6e3, so a CG target measured
    // against ‖b‖ buys ~6e3 less accuracy in watts than the tolerance reads as, and what
    // CG leaves behind arrives here as unaccounted power. Judged against the applied
    // power instead, what is left is 7.4e-4 W — the Picard radiation lag alone, the same
    // floor the fin benchmarks sit at. Measured 7.3e-6 of the loss.
    const loss = result.balance.lostByConvection + result.balance.lostByRadiation;
    expect(Math.abs(result.balance.residual) / loss).toBeLessThan(5e-5);
    expect(result.warnings.join('\n')).not.toContain('Energy balance');
  }, 120_000);
});
