const test = require("node:test");
const assert = require("node:assert/strict");
const { parsePrfpset } = require("../src/core/effects/prfpset.js");

// Mesma estrutura de um .prfpset real (o pack do Jota), reduzida a um efeito com uma chave de
// posição e um parâmetro parado. As âncoras ficam em 1 h, como o Premiere grava.
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3">
	<TreeItem ObjectID="5" ClassID="x" Version="3">
		<TreeItemBase Version="4"><Name>TEXT SLIDE &lt;</Name><Data ObjectRef="6"/></TreeItemBase>
	</TreeItem>
	<FilterPresetItem ObjectID="6" ClassID="x" Version="2">
		<FilterPresets Version="1">
			<FilterPreset Index="0" ObjectRef="7"/>
		</FilterPresets>
	</FilterPresetItem>
	<FilterPreset ObjectID="7" ClassID="x" Version="3">
		<FilterMatchName>AE.ADBE Geometry2</FilterMatchName>
		<Component ObjectRef="8"/>
		<AnchorInPoint>914457600000000</AnchorInPoint>
		<AnchorOutPoint>914902128000000</AnchorOutPoint>
		<Type>0</Type>
	</FilterPreset>
	<VideoFilterComponent ObjectID="8" ClassID="x" Version="9">
		<Component Version="6">
			<DisplayName>Transformar</DisplayName>
			<Intrinsic>false</Intrinsic>
			<Params Version="1">
				<Param Index="0" ObjectRef="9"/>
				<Param Index="1" ObjectRef="10"/>
			</Params>
		</Component>
	</VideoFilterComponent>
	<PointComponentParam ObjectID="9" ClassID="x" Version="3">
		<Keyframes>914457600000000,0.6:0.5,5,0,0.1;914902128000000,0.5:0.5,5,0,0;</Keyframes>
		<ParameterID>2</ParameterID>
		<IsTimeVarying>true</IsTimeVarying>
		<StartKeyframe>-91445760000000000,0.5:0.5,0,0</StartKeyframe>
		<Name>Posição</Name>
	</PointComponentParam>
	<VideoComponentParam ObjectID="10" ClassID="x" Version="9">
		<Keyframes></Keyframes>
		<ParameterID>11</ParameterID>
		<IsTimeVarying>false</IsTimeVarying>
		<StartKeyframe>-91445760000000000,true,0,0</StartKeyframe>
	</VideoComponentParam>
</PremiereData>`;

test(".prfpset: efeitos, duração, chaves a partir do começo do efeito e valores parados", () => {
  const p = parsePrfpset(XML);
  assert.equal(p.name, "TEXT SLIDE <");
  assert.equal(p.effects.length, 1);
  const e = p.effects[0];
  assert.deepEqual([e.matchName, e.displayName, e.seconds, e.anchor, e.intrinsic], ["AE.ADBE Geometry2", "Transformar", 1.75, "scale", false]);
  // ancorado no fim: as chaves contam do AnchorOutPoint
  const out = parsePrfpset(XML.replace("<Type>0</Type>", "<Type>2</Type>")).effects[0];
  assert.deepEqual([out.anchor, out.params[0].keys.map((k) => k.seconds)], ["out", [-1.75, 0]]);
  assert.deepEqual(e.params[0].keys, [{ seconds: 0, value: [0.6, 0.5], interp: 5 }, { seconds: 1.75, value: [0.5, 0.5], interp: 5 }]);
  assert.deepEqual([e.params[0].index, e.params[0].id, e.params[0].timeVarying], [0, 2, true]);
  assert.deepEqual([e.params[1].index, e.params[1].value, e.params[1].keys], [1, true, []]);
  assert.throws(() => parsePrfpset("<PremiereData></PremiereData>"), /predefinição de efeitos/);
});
