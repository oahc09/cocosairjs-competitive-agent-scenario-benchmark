#extension GL_EXT_shader_explicit_arithmetic_types_int32: require
precision highp float;
#define QUATER_PI         0.78539816340
#define HALF_PI           1.57079632679
#define PI                3.14159265359
#define PI2               6.28318530718
#define PI4               12.5663706144
#define INV_QUATER_PI     1.27323954474
#define INV_HALF_PI       0.63661977237
#define INV_PI            0.31830988618
#define INV_PI2           0.15915494309
#define INV_PI4           0.07957747155
#define EPSILON           1e-6
#define EPSILON_LOWP      1e-4
#define LOG2              1.442695
#define EXP_VALUE         2.71828183f
#define FP_MAX            65504.0
#define FP_SCALE          0.0009765625
#define FP_SCALE_INV      1024.0
#define GRAY_VECTOR       vec3(0.299, 0.587, 0.114)
highp float decode32 (highp vec4 rgba) {
rgba = rgba * 255.0;
highp float Sign = 1.0 - (step(128.0, (rgba[3]) + 0.5)) * 2.0;
highp float Exponent = 2.0 * (mod(float(int((rgba[3]) + 0.5)), 128.0)) + (step(128.0, (rgba[2]) + 0.5)) - 127.0;
highp float Mantissa = (mod(float(int((rgba[2]) + 0.5)), 128.0)) * 65536.0 + rgba[1] * 256.0 + rgba[0] + 8388608.0;
return Sign * exp2(Exponent - 23.0) * Mantissa;
}
struct StandardVertInput {
highp vec4 position;
vec3 normal;
vec4 tangent;
};
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_texCoord;
layout(location = 3) in vec4 a_tangent;
#if CC_USE_SKINNING
layout(location = 4) in u32vec4 a_joints;
layout(location = 5) in vec4 a_weights;
#endif
#if USE_INSTANCING
#if CC_USE_BAKED_ANIMATION
layout(location = 6) in highp vec4 a_jointAnimInfo;
#endif
layout(location = 7) in vec4 a_matWorld0;
layout(location = 8) in vec4 a_matWorld1;
layout(location = 9) in vec4 a_matWorld2;
#if CC_USE_LIGHTMAP
layout(location = 10) in vec4 a_lightingMapUVParam;
#endif
#if CC_RECEIVE_SHADOW
layout(location = 11) in vec2 a_localShadowBias;
#endif
#elif USE_BATCHING
layout(location = 12) in float a_dyn_batch_id;
#endif
#if CC_USE_MORPH
int getVertexId() {
return gl_VertexIndex;
}
#endif
#if CC_USE_MORPH
layout(set = 2, binding = 4) uniform CCMorph {
vec4 cc_displacementWeights[15];
vec4 cc_displacementTextureInfo;
};
#if CC_MORPH_TARGET_HAS_POSITION
layout(set = 2, binding = 7) uniform sampler2D cc_PositionDisplacements;
#endif
#if CC_MORPH_TARGET_HAS_NORMAL
layout(set = 2, binding = 8) uniform sampler2D cc_NormalDisplacements;
#endif
#if CC_MORPH_TARGET_HAS_TANGENT
layout(set = 2, binding = 9) uniform sampler2D cc_TangentDisplacements;
#endif
vec2 getPixelLocation(vec2 textureResolution, int pixelIndex) {
float pixelIndexF = float(pixelIndex);
float x = mod(pixelIndexF, textureResolution.x);
float y = floor(pixelIndexF / textureResolution.x);
return vec2(x, y);
}
vec2 getPixelCoordFromLocation(vec2 location, vec2 textureResolution) {
return (vec2(location.x, location.y) + .5) / textureResolution;
}
#if CC_DEVICE_SUPPORT_FLOAT_TEXTURE
vec4 fetchVec3ArrayFromTexture(sampler2D tex, int pixelIndex) {
ivec2 texSize = textureSize(tex, 0);
return texelFetch(tex, ivec2(pixelIndex % texSize.x, pixelIndex / texSize.x), 0);
}
#else
vec4 fetchVec3ArrayFromTexture(sampler2D tex, int elementIndex) {
int pixelIndex = elementIndex * 4;
vec2 location = getPixelLocation(cc_displacementTextureInfo.xy, pixelIndex);
vec2 x = getPixelCoordFromLocation(location + vec2(0.0, 0.0), cc_displacementTextureInfo.xy);
vec2 y = getPixelCoordFromLocation(location + vec2(1.0, 0.0), cc_displacementTextureInfo.xy);
vec2 z = getPixelCoordFromLocation(location + vec2(2.0, 0.0), cc_displacementTextureInfo.xy);
return vec4(
decode32(texture(tex, x)),
decode32(texture(tex, y)),
decode32(texture(tex, z)),
1.0
);
}
#endif
float getDisplacementWeight(int index) {
int quot = index / 4;
int remainder = index - quot * 4;
if (remainder == 0) {
return cc_displacementWeights[quot].x;
} else if (remainder == 1) {
return cc_displacementWeights[quot].y;
} else if (remainder == 2) {
return cc_displacementWeights[quot].z;
} else {
return cc_displacementWeights[quot].w;
}
}
vec3 getVec3DisplacementFromTexture(sampler2D tex, int vertexIndex) {
#if CC_MORPH_PRECOMPUTED
return fetchVec3ArrayFromTexture(tex, vertexIndex).rgb;
#else
vec3 result = vec3(0, 0, 0);
int nVertices = int(cc_displacementTextureInfo.z);
for (int iTarget = 0; iTarget < CC_MORPH_TARGET_COUNT; ++iTarget) {
result += (fetchVec3ArrayFromTexture(tex, nVertices * iTarget + vertexIndex).rgb * getDisplacementWeight(iTarget));
}
return result;
#endif
}
#if CC_MORPH_TARGET_HAS_POSITION
vec3 getPositionDisplacement(int vertexId) {
return getVec3DisplacementFromTexture(cc_PositionDisplacements, vertexId);
}
#endif
#if CC_MORPH_TARGET_HAS_NORMAL
vec3 getNormalDisplacement(int vertexId) {
return getVec3DisplacementFromTexture(cc_NormalDisplacements, vertexId);
}
#endif
#if CC_MORPH_TARGET_HAS_TANGENT
vec3 getTangentDisplacement(int vertexId) {
return getVec3DisplacementFromTexture(cc_TangentDisplacements, vertexId);
}
#endif
void applyMorph (inout vec4 position, inout vec3 normal, inout vec4 tangent) {
int vertexId = getVertexId();
#if CC_MORPH_TARGET_HAS_POSITION
position.xyz = position.xyz + getPositionDisplacement(vertexId);
#endif
#if CC_MORPH_TARGET_HAS_NORMAL
normal.xyz = normal.xyz + getNormalDisplacement(vertexId);
#endif
#if CC_MORPH_TARGET_HAS_TANGENT
tangent.xyz = tangent.xyz + getTangentDisplacement(vertexId);
#endif
}
void applyMorph (inout vec4 position) {
#if CC_MORPH_TARGET_HAS_POSITION
position.xyz = position.xyz + getPositionDisplacement(getVertexId());
#endif
}
#endif
#if CC_USE_SKINNING
#if CC_USE_BAKED_ANIMATION
layout(set = 2, binding = 3) uniform CCSkinningTexture {
highp vec4 cc_jointTextureInfo;
};
layout(set = 2, binding = 2) uniform CCSkinningAnimation {
highp vec4 cc_jointAnimInfo;
};
layout(set = 2, binding = 6) uniform highp sampler2D cc_jointTexture;
void CCGetJointTextureCoords(float pixelsPerJoint, float jointIdx, out highp float x, out highp float y, out highp float invSize)
{
#if USE_INSTANCING
highp float temp = pixelsPerJoint * (a_jointAnimInfo.x * a_jointAnimInfo.y + jointIdx) + a_jointAnimInfo.z;
#else
highp float temp = pixelsPerJoint * (cc_jointAnimInfo.x * cc_jointTextureInfo.y + jointIdx) + cc_jointTextureInfo.z;
#endif
invSize = cc_jointTextureInfo.w;
highp float tempY = floor(temp * invSize);
x = floor(temp - tempY * cc_jointTextureInfo.x);
y = (tempY + 0.5) * invSize;
}
#else
#if CC_USE_REAL_TIME_JOINT_TEXTURE
layout(set = 2, binding = 6) uniform highp sampler2D cc_realtimeJoint;
#else
layout(set = 2, binding = 3) uniform CCSkinning {
highp vec4 cc_joints[CC_JOINT_UNIFORM_CAPACITY * 3];
};
#endif
#endif
#if CC_USE_BAKED_ANIMATION
#if CC_DEVICE_SUPPORT_FLOAT_TEXTURE
mat4 getJointMatrix (float i) {
highp float x, y, invSize;
CCGetJointTextureCoords(3.0, i, x, y, invSize);
vec4 v1 = texture(cc_jointTexture, vec2((x + 0.5) * invSize, y));
vec4 v2 = texture(cc_jointTexture, vec2((x + 1.5) * invSize, y));
vec4 v3 = texture(cc_jointTexture, vec2((x + 2.5) * invSize, y));
return mat4(vec4(v1.xyz, 0.0), vec4(v2.xyz, 0.0), vec4(v3.xyz, 0.0), vec4(v1.w, v2.w, v3.w, 1.0));
}
#else
mat4 getJointMatrix (float i) {
highp float x, y, invSize;
CCGetJointTextureCoords(12.0, i, x, y, invSize);
vec4 v1 = vec4(
decode32(texture(cc_jointTexture, vec2((x + 0.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 1.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 2.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 3.5) * invSize, y)))
);
vec4 v2 = vec4(
decode32(texture(cc_jointTexture, vec2((x + 4.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 5.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 6.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 7.5) * invSize, y)))
);
vec4 v3 = vec4(
decode32(texture(cc_jointTexture, vec2((x + 8.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 9.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 10.5) * invSize, y))),
decode32(texture(cc_jointTexture, vec2((x + 11.5) * invSize, y)))
);
return mat4(vec4(v1.xyz, 0.0), vec4(v2.xyz, 0.0), vec4(v3.xyz, 0.0), vec4(v1.w, v2.w, v3.w, 1.0));
}
#endif
#else
#if CC_USE_REAL_TIME_JOINT_TEXTURE
#if CC_DEVICE_SUPPORT_FLOAT_TEXTURE
mat4 getJointMatrix (float i) {
float x = i;
vec4 v1 = texture(cc_realtimeJoint, vec2( x / 256.0, 0.5 / 3.0));
vec4 v2 = texture(cc_realtimeJoint, vec2( x / 256.0, 1.5 / 3.0));
vec4 v3 = texture(cc_realtimeJoint, vec2( x / 256.0, 2.5 / 3.0));
return mat4(vec4(v1.xyz, 0.0), vec4(v2.xyz, 0.0), vec4(v3.xyz, 0.0), vec4(v1.w, v2.w, v3.w, 1.0));
}
#else
mat4 getJointMatrix (float i) {
float x = 4.0 * i;
vec4 v1 = vec4(
decode32(texture(cc_realtimeJoint, vec2((x + 0.5)/ 1024.0, 0.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 1.5)/ 1024.0, 0.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 2.5)/ 1024.0, 0.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 3.5)/ 1024.0, 0.5 / 3.0)))
);
vec4 v2 = vec4(
decode32(texture(cc_realtimeJoint, vec2((x + 0.5)/ 1024.0, 1.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 1.5)/ 1024.0, 1.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 2.5)/ 1024.0, 1.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 3.5)/ 1024.0, 1.5 / 3.0)))
);
vec4 v3 = vec4(
decode32(texture(cc_realtimeJoint, vec2((x + 0.5)/ 1024.0, 2.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 1.5)/ 1024.0, 2.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 2.5)/ 1024.0, 2.5 / 3.0))),
decode32(texture(cc_realtimeJoint, vec2((x + 3.5)/ 1024.0, 2.5 / 3.0)))
);
return mat4(vec4(v1.xyz, 0.0), vec4(v2.xyz, 0.0), vec4(v3.xyz, 0.0), vec4(v1.w, v2.w, v3.w, 1.0));
}
#endif
#else
mat4 getJointMatrix (float i) {
int idx = int(i);
vec4 v1 = cc_joints[idx * 3];
vec4 v2 = cc_joints[idx * 3 + 1];
vec4 v3 = cc_joints[idx * 3 + 2];
return mat4(vec4(v1.xyz, 0.0), vec4(v2.xyz, 0.0), vec4(v3.xyz, 0.0), vec4(v1.w, v2.w, v3.w, 1.0));
}
#endif
#endif
mat4 skinMatrix () {
vec4 joints = vec4(a_joints);
return getJointMatrix(joints.x) * a_weights.x
+ getJointMatrix(joints.y) * a_weights.y
+ getJointMatrix(joints.z) * a_weights.z
+ getJointMatrix(joints.w) * a_weights.w;
}
void CCSkin (inout vec4 position) {
mat4 m = skinMatrix();
position = m * position;
}
void CCSkin (inout vec4 position, inout vec3 normal, inout vec4 tangent) {
mat4 m = skinMatrix();
position = m * position;
normal = (m * vec4(normal, 0.0)).xyz;
tangent.xyz = (m * vec4(tangent.xyz, 0.0)).xyz;
}
#endif
void CCVertInput(inout vec4 In)
{
In = vec4(a_position, 1.0);
#if CC_USE_MORPH
applyMorph(In);
#endif
#if CC_USE_SKINNING
CCSkin(In);
#endif
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
#if !USE_INSTANCING
#if USE_BATCHING
layout(set = 2, binding = 0) uniform CCLocalBatched {
highp mat4 cc_matWorlds[10];
};
#else
layout(set = 2, binding = 0) uniform CCLocal {
highp mat4 cc_matWorld;
highp mat4 cc_matWorldIT;
highp vec4 cc_lightingMapUVParam;
highp vec4 cc_localShadowBias;
};
#endif
#endif
void CCGetWorldMatrix(out mat4 matWorld)
{
#if USE_INSTANCING
matWorld = mat4(
vec4(a_matWorld0.xyz, 0.0),
vec4(a_matWorld1.xyz, 0.0),
vec4(a_matWorld2.xyz, 0.0),
vec4(a_matWorld0.w, a_matWorld1.w, a_matWorld2.w, 1.0)
);
#elif USE_BATCHING
matWorld = cc_matWorlds[int(a_dyn_batch_id)];
#else
matWorld = cc_matWorld;
#endif
}
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
#if !CC_USE_ACCURATE_FOG
layout(location = 0) out float v_fog_factor;
#endif
void CC_TRANSFER_FOG(vec4 pos) {
#if !CC_USE_ACCURATE_FOG
CC_TRANSFER_FOG_BASE(pos, v_fog_factor);
#endif
}
#if USE_VERTEX_COLOR
layout(location = 14) in lowp vec4 a_color;
layout(location = 1) out lowp vec4 v_color;
#endif
#if USE_TEXTURE
layout(location = 2) out vec2 v_uv;
layout(set = 1, binding = 0) uniform TexCoords {
vec4 tilingOffset;
};
#endif
vec4 vert () {
vec4 position;
CCVertInput(position);
mat4 matWorld;
CCGetWorldMatrix(matWorld);
#if USE_TEXTURE
v_uv = a_texCoord * tilingOffset.xy + tilingOffset.zw;
#if SAMPLE_FROM_RT
v_uv = cc_cameraPos.w > 1.0 ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv;
#endif
#endif
#if USE_VERTEX_COLOR
v_color = a_color;
#endif
CC_TRANSFER_FOG(matWorld * position);
return cc_matProj * (cc_matView * matWorld) * position;
}
void main() { gl_Position = vert(); }