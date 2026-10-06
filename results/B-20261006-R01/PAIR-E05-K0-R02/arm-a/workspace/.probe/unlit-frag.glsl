
precision highp float;
vec3 ACESToneMap (vec3 color) {
color = min(color, vec3(8.0));
const float A = 2.51;
const float B = 0.03;
const float C = 2.43;
const float D = 0.59;
const float E = 0.14;
return (color * (A * color + B)) / (color * (C * color + D) + E);
}
vec3 SRGBToLinear (vec3 gamma) {
return gamma * gamma;
}
vec4 CCFragOutput (vec4 color) {
#if CC_USE_HDR
color.rgb = ACESToneMap(color.rgb);
#endif
color.rgb = sqrt(color.rgb);
return color;
}
layout(set = 0, binding = 0) uniform CCGlobal {
highp   vec4 cc_time;
mediump vec4 cc_screenSize;
mediump vec4 cc_nativeSize;
mediump vec4 cc_debug_view_mode;
mediump vec4 cc_debug_view_composite_pack_1;
mediump vec4 cc_debug_view_composite_pack_2;
mediump vec4 cc_debug_view_composite_pack_3;
};
layout(set = 0, binding = 1) uniform CCCamera {
highp   mat4 cc_matView;
highp   mat4 cc_matViewInv;
highp   mat4 cc_matProj;
highp   mat4 cc_matProjInv;
highp   mat4 cc_matViewProj;
highp   mat4 cc_matViewProjInv;
highp   vec4 cc_cameraPos;
mediump vec4 cc_surfaceTransform;
mediump vec4 cc_screenScale;
mediump vec4 cc_exposure;
mediump vec4 cc_mainLitDir;
mediump vec4 cc_mainLitColor;
mediump vec4 cc_ambientSky;
mediump vec4 cc_ambientGround;
mediump vec4 cc_fogColor;
mediump vec4 cc_fogBase;
mediump vec4 cc_fogAdd;
mediump vec4 cc_nearFar;
mediump vec4 cc_viewPort;
};
#if CC_USE_FOG != 4
float LinearFog(vec4 pos, vec3 cameraPos, float fogStart, float fogEnd) {
vec4 wPos = pos;
float cam_dis = distance(cameraPos, wPos.xyz);
return clamp((fogEnd - cam_dis) / (fogEnd - fogStart), 0., 1.);
}
float ExpFog(vec4 pos, vec3 cameraPos, float fogStart, float fogDensity, float fogAtten) {
vec4 wPos = pos;
float cam_dis = max(distance(cameraPos, wPos.xyz) - fogStart, 0.0) / fogAtten * 4.;
float f = exp(-cam_dis * fogDensity);
return f;
}
float ExpSquaredFog(vec4 pos, vec3 cameraPos, float fogStart, float fogDensity, float fogAtten) {
vec4 wPos = pos;
float cam_dis = max(distance(cameraPos, wPos.xyz) - fogStart, 0.0) / fogAtten * 4.;
float f = exp(-cam_dis * cam_dis * fogDensity * fogDensity);
return f;
}
float LayeredFog(vec4 pos, vec3 cameraPos, float fogTop, float fogRange, float fogAtten) {
vec4 wPos = pos;
vec3 camWorldProj = cameraPos.xyz;
camWorldProj.y = 0.;
vec3 worldPosProj = wPos.xyz;
worldPosProj.y = 0.;
float fDeltaD = distance(worldPosProj, camWorldProj) / fogAtten * 2.0;
float fDeltaY, fDensityIntegral;
if (cameraPos.y > fogTop) {
if (wPos.y < fogTop) {
fDeltaY = (fogTop - wPos.y) / fogRange * 2.0;
fDensityIntegral = fDeltaY * fDeltaY * 0.5;
}
else {
fDeltaY = 0.;
fDensityIntegral = 0.;
}
}
else {
if (wPos.y < fogTop) {
float fDeltaA = (fogTop - cameraPos.y) / fogRange * 2.;
float fDeltaB = (fogTop - wPos.y) / fogRange * 2.;
fDeltaY = abs(fDeltaA - fDeltaB);
fDensityIntegral = abs((fDeltaA * fDeltaA * 0.5) - (fDeltaB * fDeltaB * 0.5));
}
else {
fDeltaY = abs(fogTop - cameraPos.y) / fogRange * 2.;
fDensityIntegral = abs(fDeltaY * fDeltaY * 0.5);
}
}
float fDensity;
if (fDeltaY != 0.) {
fDensity = (sqrt(1.0 + ((fDeltaD / fDeltaY) * (fDeltaD / fDeltaY)))) * fDensityIntegral;
}
else {
fDensity = 0.;
}
float f = exp(-fDensity);
return f;
}
#endif
void CC_TRANSFER_FOG_BASE(vec4 pos, out float factor)
{
#if CC_USE_FOG == 0
factor = LinearFog(pos, cc_cameraPos.xyz, cc_fogBase.x, cc_fogBase.y);
#elif CC_USE_FOG == 1
factor = ExpFog(pos, cc_cameraPos.xyz, cc_fogBase.x, cc_fogBase.z, cc_fogAdd.z);
#elif CC_USE_FOG == 2
factor = ExpSquaredFog(pos, cc_cameraPos.xyz, cc_fogBase.x, cc_fogBase.z, cc_fogAdd.z);
#elif CC_USE_FOG == 3
factor = LayeredFog(pos, cc_cameraPos.xyz, cc_fogAdd.x, cc_fogAdd.y, cc_fogAdd.z);
#else
factor = 1.0;
#endif
}
void CC_APPLY_FOG_BASE(inout vec4 color, float factor) {
color = vec4(mix(cc_fogColor.rgb, color.rgb, factor), color.a);
}
#if !CC_USE_ACCURATE_FOG
layout(location = 0) in float v_fog_factor;
#endif
void CC_APPLY_FOG(inout vec4 color) {
#if !CC_USE_ACCURATE_FOG
CC_APPLY_FOG_BASE(color, v_fog_factor);
#endif
}
void CC_APPLY_FOG(inout vec4 color, vec3 worldPos) {
#if CC_USE_ACCURATE_FOG
float factor;
CC_TRANSFER_FOG_BASE(vec4(worldPos, 1.0), factor);
#else
float factor = v_fog_factor;
#endif
CC_APPLY_FOG_BASE(color, factor);
}
#if USE_ALPHA_TEST
#endif
#if USE_TEXTURE
layout(location = 2) in vec2 v_uv;
layout(set = 1, binding = 2) uniform sampler2D mainTexture;
#endif
layout(set = 1, binding = 1) uniform Constant {
vec4 mainColor;
vec4 colorScaleAndCutoff;
};
#if USE_VERTEX_COLOR
layout(location = 1) in lowp vec4 v_color;
#endif
vec4 frag () {
vec4 o = mainColor;
o.rgb *= colorScaleAndCutoff.xyz;
#if USE_VERTEX_COLOR
o.rgb *= SRGBToLinear(v_color.rgb);
o.a *= v_color.a;
#endif
#if USE_TEXTURE
vec4 texColor = texture(mainTexture, v_uv);
texColor.rgb = SRGBToLinear(texColor.rgb);
o *= texColor;
#endif
#if USE_ALPHA_TEST
if (o.ALPHA_TEST_CHANNEL < colorScaleAndCutoff.w) discard;
#endif
CC_APPLY_FOG(o);
return CCFragOutput(o);
}
layout(location = 0) out vec4 cc_FragColor;
void main() { cc_FragColor = frag(); }