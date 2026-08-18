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
 * actually contains, so it carries 7734 cm² — outer skin, inner skin and edge bands.
 * Now that each sealed cavity holds a temperature of its own, the skin facing ambient
 * is the only way out of the model, so the total loss and the open-air loss are the
 * same watts and both are comparable to the reference's 61 W. Before that they were
 * 101.5 W and 64.8 W, and the difference was heat sinking into a sealed box.
 *
 * We read 82.5 W where the reference reads 61 W, over the same surface. The pocket
 * carries heat from the buried block to the skin by convection and radiation across
 * it, which is a path a mesh with no interior faces does not have at all, and the skin
 * runs 33.5 K above ambient here against the reference's 22.9 K.
 *
 * The two skins are merged onto one DOF per in-plane position wherever they can be
 * paired, so the sheet conducts its full thickness in plane and is isothermal across
 * it — see `pairThroughThickness`. Without that the inner skin is a near-lossless
 * spreader that the heat from the block cannot leave.
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
import type { BoundaryCondition, Scenario, Target, ThermalModel } from '../core/types';

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
        targets: [{ type: 'part', partId: block!.id }],
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
      'cavity air:',
      result.balance.perCavity
        .map(
          (cavity) =>
            `#${cavity.cavityId} ${kelvinToCelsius(cavity.temperature).toFixed(1)} C` +
            ` (net ${cavity.netFlow.toExponential(1)} W)`,
        )
        .join(', ') || 'none',
    );
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

    // ...and the heat leaving that skin is the same order as the reference's 61 W.
    // Measured 82.5 W: higher because the sealed pocket carries the buried block's heat
    // to the skin, and the reference mesh has no interior for it to cross. That path is
    // mostly radiation, so this bound is only as trustworthy as the enclosure emissivity
    // driving it — 0.2, confirmed against the hardware as a bare aluminium block, which
    // is the oxidised-bare figure and sits consistently with the SS304 skin's 0.15.
    // Lower it and this comes back down towards the reference; it should not be lowered
    // to make that happen.
    expect(exposed.watts).toBeGreaterThan(70);
    expect(exposed.watts).toBeLessThan(95);

    // The falsifiable prediction of the cavity air node, and the point of this test:
    // ambient is the only exit, so the total loss and the loss through the open-air
    // skin are the same watts. A sealed pocket that still sank heat would show up here
    // as a total above the skin's figure, which is what 101.5 W against 64.8 W was.
    const loss = result.balance.lostByConvection + result.balance.lostByRadiation;
    expect(loss / exposed.watts).toBeCloseTo(1, 4);
    expect(loss).toBeLessThan(90);
    // Nothing is stranded any more: every cavity DOF is assembled into somebody's row.
    expect(result.warnings.join('\n')).not.toContain('exchange no heat with anything');

    // Each pocket conserves what crosses it, and sits between the block that heats it
    // and the room. The four hottest are wholly bounded by the pinned block, so their
    // air reaches 200 °C and carries nothing at all. Measured worst: 4.7e-5 W.
    expect(result.balance.perCavity).toHaveLength(scenario.cavities.length);
    for (const cavity of result.balance.perCavity) {
      expect(Math.abs(cavity.netFlow) / loss).toBeLessThan(1e-5);
      expect(cavity.temperature).toBeGreaterThan(scenario.ambient);
      expect(cavity.temperature).toBeLessThanOrEqual(celsiusToKelvin(200) + 1e-6);
    }

    // This is the model the residual has to be watched on, because it is the one with
    // PERFECT_CONTACT joints on a pinned part: eliminating that pin folds conductance ×
    // 473 K into its neighbours' rows and inflates ‖b‖ by ~6e3, so a CG target measured
    // against ‖b‖ buys ~6e3 less accuracy in watts than the tolerance reads as, and what
    // CG leaves behind arrives here as unaccounted power. Judged against the applied
    // power instead, what is left is 1.8e-4 W — the Picard radiation lag alone, the same
    // floor the fin benchmarks sit at. Measured 2.2e-6 of the loss.
    expect(Math.abs(result.balance.residual) / loss).toBeLessThan(5e-5);
    expect(result.warnings.join('\n')).not.toContain('Energy balance');
  }, 120_000);

  /**
   * Grouping several targets under one condition is an authoring convenience, not a
   * change to the physics. Both halves of that claim are checked on real geometry:
   * a group pins exactly what the separate conditions it replaces would pin, and its
   * watts are the total over the whole group however its members overlap.
   */
  it('treats a group as authoring convenience rather than a change to the answer', async () => {
    const model = await loadTbte();
    const sheet = model.parts.find((p) => p.name === 'glava');
    expect(sheet).toBeDefined();

    const [triStart, triEnd] = sheet!.triRange;
    const faceIds = [
      ...new Set(Array.from({ length: triEnd - triStart }, (_, i) => model.triFace[triStart + i])),
    ].slice(0, 2);
    expect(faceIds).toHaveLength(2);
    const faces: Target[] = faceIds.map((faceId) => ({ type: 'face', partId: sheet!.id, faceId }));

    const grouped = createDefaultScenario(20);
    grouped.boundaryConditions = [
      {
        id: 'grouped',
        kind: 'fixedTemp',
        targets: faces,
        value: celsiusToKelvin(200),
        enabled: true,
      },
    ];

    const separate = createDefaultScenario(20);
    separate.boundaryConditions = faces.map((face, index): BoundaryCondition => ({
      id: `separate-${index}`,
      kind: 'fixedTemp',
      targets: [face],
      value: celsiusToKelvin(200),
      enabled: true,
    }));

    const groupedResult = solveShell(model, grouped);
    const separateResult = solveShell(model, separate);
    let maxDifference = 0;
    for (let node = 0; node < model.nodeCount; node++) {
      maxDifference = Math.max(
        maxDifference,
        Math.abs(groupedResult.temperature[node] - separateResult.temperature[node]),
      );
    }
    expect(maxDifference).toBe(0);
    expect(groupedResult.balance.injectedAtFixed).toBeCloseTo(
      separateResult.balance.injectedAtFixed,
      9,
    );

    // The face lies inside the part, so the union is just the part's nodes and the 5 W
    // lands once. Two separately authored 5 W conditions over the same nodes inject 10 W.
    const overlapping = createDefaultScenario(20);
    overlapping.boundaryConditions = [
      {
        id: 'overlapping',
        kind: 'heatLoad',
        targets: [{ type: 'part', partId: sheet!.id }, faces[0]],
        watts: 5,
        enabled: true,
      },
    ];
    expect(solveShell(model, overlapping).balance.injectedAtLoads).toBeCloseTo(5, 9);
  }, 120_000);
});
