/**
 * Shader program compilation with a cache keyed by the generated source.
 * Compiles are started with `prefetch` and only checked when a program is first used, so with
 * KHR_parallel_shader_compile (and Chrome's GPU process in general) they never block a frame.
 */
import { toGL } from '../../color/matrices';
import type { Uniform } from '../types';

export const FULLSCREEN_VS = /* glsl */ `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Set one uniform from its typed value. */
export function setUniform(gl: WebGL2RenderingContext, loc: WebGLUniformLocation | null, v: Uniform) {
  if (!loc) return;
  switch (v.t) {
    case 'f': gl.uniform1f(loc, v.v); break;
    case 'i': gl.uniform1i(loc, v.v); break;
    case 'v2': gl.uniform2f(loc, v.v[0], v.v[1]); break;
    case 'v3': gl.uniform3f(loc, v.v[0], v.v[1], v.v[2]); break;
    case 'v4': gl.uniform4f(loc, v.v[0], v.v[1], v.v[2], v.v[3]); break;
    case 'm3': gl.uniformMatrix3fv(loc, false, toGL(v.v)); break;
    case 'fa': gl.uniform1fv(loc, v.v); break;
    case 'v2a': gl.uniform2fv(loc, v.v); break;
    case 'v3a': gl.uniform3fv(loc, v.v); break;
    case 'v4a': gl.uniform4fv(loc, v.v); break;
  }
}

/** Sampler uniforms a fragment shader declares (each must be bound on every draw). */
export function declaredSamplers(src: string): Array<{ name: string; is3d: boolean }> {
  const out: Array<{ name: string; is3d: boolean }> = [];
  const re = /uniform\s+(?:(?:highp|mediump|lowp)\s+)?(sampler2D|sampler3D)\s+(\w+)\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push({ name: m[2], is3d: m[1] === 'sampler3D' });
  return out;
}

export interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
  loc(name: string): WebGLUniformLocation | null;
}

const COMPLETION_STATUS_KHR = 0x91b1;

function numbered(src: string) {
  return src.split('\n').map((l, i) => `${String(i + 1).padStart(4)}: ${l}`).join('\n');
}

export class ProgramCache {
  private cache = new Map<string, Program>();
  private pending = new Map<string, { program: WebGLProgram; fs: WebGLShader }>();
  private vs: WebGLShader | null = null;
  private readonly parallel: boolean;

  constructor(private gl: WebGL2RenderingContext) {
    this.parallel = !!gl.getExtension('KHR_parallel_shader_compile');
  }

  /** Start compiling and linking without waiting for the result. */
  prefetch(fragmentSource: string) {
    if (this.cache.has(fragmentSource) || this.pending.has(fragmentSource)) return;
    const gl = this.gl;
    if (!this.vs) {
      this.vs = gl.createShader(gl.VERTEX_SHADER)!;
      gl.shaderSource(this.vs, FULLSCREEN_VS);
      gl.compileShader(this.vs);
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
    gl.shaderSource(fs, fragmentSource);
    gl.compileShader(fs);
    const program = gl.createProgram()!;
    gl.attachShader(program, this.vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    this.pending.set(fragmentSource, { program, fs });
  }

  /** True when `get` would not block (always true without the parallel-compile extension). */
  isReady(fragmentSource: string): boolean {
    if (this.cache.has(fragmentSource)) return true;
    const p = this.pending.get(fragmentSource);
    if (!p) return false;
    return !this.parallel || !!this.gl.getProgramParameter(p.program, COMPLETION_STATUS_KHR);
  }

  get(fragmentSource: string): Program {
    const hit = this.cache.get(fragmentSource);
    if (hit) return hit;
    this.prefetch(fragmentSource);
    const gl = this.gl;
    const { program, fs } = this.pending.get(fragmentSource)!;
    this.pending.delete(fragmentSource);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(this.vs!) || gl.getProgramInfoLog(program);
      gl.deleteShader(fs);
      gl.deleteProgram(program);
      throw new Error(`Shader program failed:\n${log}\n${numbered(fragmentSource)}`);
    }
    gl.detachShader(program, fs);
    gl.deleteShader(fs);
    const uniforms = new Map<string, WebGLUniformLocation | null>();
    const p: Program = {
      program,
      uniforms,
      loc(name) {
        if (!uniforms.has(name)) uniforms.set(name, gl.getUniformLocation(program, name));
        return uniforms.get(name)!;
      },
    };
    this.cache.set(fragmentSource, p);
    return p;
  }

  dispose() {
    for (const p of this.cache.values()) this.gl.deleteProgram(p.program);
    for (const p of this.pending.values()) { this.gl.deleteProgram(p.program); this.gl.deleteShader(p.fs); }
    this.cache.clear();
    this.pending.clear();
    if (this.vs) this.gl.deleteShader(this.vs);
    this.vs = null;
  }
}
