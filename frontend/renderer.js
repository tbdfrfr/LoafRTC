const WEBGL_VERTEX_SOURCE = `#version 300 es
in vec2 a_position;
in vec2 a_uv;
out vec2 v_uv;

void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

const WEBGL_FRAGMENT_SOURCE = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_frame;

void main() {
  outColor = texture(u_frame, v_uv);
}
`;

const WEBGPU_SHADER_SOURCE = `
struct Uniforms {
  scale: vec2f,
}

@group(0) @binding(0) var u_sampler: sampler;
@group(0) @binding(1) var u_frame: texture_external;
@group(0) @binding(2) var<uniform> u_uniforms: Uniforms;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VsOut {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0)
  );

  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 0.0),
    vec2f(0.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(1.0, 0.0)
  );

  var out: VsOut;
  let pos = positions[vertex_index] * vec2f(u_uniforms.scale.x, u_uniforms.scale.y);
  out.position = vec4f(pos, 0.0, 1.0);
  out.uv = uvs[vertex_index];
  return out;
}

@fragment
fn fs_main(in_data: VsOut) -> @location(0) vec4f {
  return textureSampleBaseClampToEdge(u_frame, u_sampler, in_data.uv);
}
`;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed to create shader');
  }

  gl.shaderSource(shader, source);
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || 'unknown shader compile error';
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failure: ${log}`);
  }

  return shader;
}

function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);

  const program = gl.createProgram();
  if (!program) {
    throw new Error('Failed to create WebGL program');
  }

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) || 'unknown link error';
    gl.deleteProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    throw new Error(`WebGL program link failure: ${log}`);
  }

  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  return program;
}

export class StreamRenderer {
  constructor() {
    this.canvas = null;
    this.backend = null;
    this.videoWidth = 16;
    this.videoHeight = 9;

    this.webgpu = null;
    this.webgl = null;
  }

  async initialize(canvas) {
    if (!(canvas instanceof HTMLCanvasElement)) {
      throw new Error('StreamRenderer requires a canvas element');
    }

    this.canvas = canvas;
    this.resize(canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight);

    const initializedWebGpu = await this.#initWebGpu();
    if (initializedWebGpu) {
      this.backend = 'webgpu';
      return;
    }

    const initializedWebGl = this.#initWebGl();
    if (initializedWebGl) {
      this.backend = 'webgl2';
      return;
    }

    throw new Error('No supported renderer backend found (WebGPU/WebGL2 unavailable)');
  }

  resize(width, height) {
    if (!this.canvas) {
      return;
    }

    const safeWidth = clamp(Math.floor(width || 1), 1, 16384);
    const safeHeight = clamp(Math.floor(height || 1), 1, 16384);
    const dpr = clamp(window.devicePixelRatio || 1, 1, 3);

    this.canvas.width = Math.max(1, Math.floor(safeWidth * dpr));
    this.canvas.height = Math.max(1, Math.floor(safeHeight * dpr));
  }

  renderFrame(videoFrame) {
    if (!videoFrame || !this.canvas || !this.backend) {
      return;
    }

    this.videoWidth = videoFrame.displayWidth || videoFrame.codedWidth || this.videoWidth;
    this.videoHeight = videoFrame.displayHeight || videoFrame.codedHeight || this.videoHeight;

    if (this.backend === 'webgpu') {
      this.#renderWebGpu(videoFrame);
      return;
    }

    this.#renderWebGl(videoFrame);
  }

  #computeScale() {
    const canvasWidth = Math.max(this.canvas.width, 1);
    const canvasHeight = Math.max(this.canvas.height, 1);

    const videoAspect = this.videoWidth / this.videoHeight;
    const canvasAspect = canvasWidth / canvasHeight;

    if (videoAspect > canvasAspect) {
      return [1.0, canvasAspect / videoAspect];
    }

    return [videoAspect / canvasAspect, 1.0];
  }

  async #initWebGpu() {
    if (!navigator.gpu || !this.canvas) {
      return false;
    }

    const context = this.canvas.getContext('webgpu');
    if (!context) {
      return false;
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      return false;
    }

    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();

    context.configure({
      device,
      format,
      alphaMode: 'opaque',
    });

    const shaderModule = device.createShaderModule({ code: WEBGPU_SHADER_SOURCE });
    const uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{ format }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    this.webgpu = {
      context,
      device,
      pipeline,
      sampler,
      uniformBuffer,
    };

    return true;
  }

  #renderWebGpu(videoFrame) {
    if (!this.webgpu) {
      return;
    }

    const { context, device, pipeline, sampler, uniformBuffer } = this.webgpu;
    const [scaleX, scaleY] = this.#computeScale();

    const uniforms = new Float32Array([scaleX, scaleY, 0, 0]);
    device.queue.writeBuffer(uniformBuffer, 0, uniforms.buffer, uniforms.byteOffset, uniforms.byteLength);

    let externalTexture;
    try {
      externalTexture = device.importExternalTexture({ source: videoFrame });
    } catch (_err) {
      return;
    }

    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: externalTexture },
        { binding: 2, resource: { buffer: uniformBuffer } },
      ],
    });

    const commandEncoder = device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    });

    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6, 1, 0, 0);
    pass.end();

    device.queue.submit([commandEncoder.finish()]);
  }

  #initWebGl() {
    if (!this.canvas) {
      return false;
    }

    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });

    if (!gl) {
      return false;
    }

    const program = createProgram(gl, WEBGL_VERTEX_SOURCE, WEBGL_FRAGMENT_SOURCE);

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();

    if (!vao || !buffer || !texture) {
      return false;
    }

    const positionLoc = gl.getAttribLocation(program, 'a_position');
    const uvLoc = gl.getAttribLocation(program, 'a_uv');

    const vertices = new Float32Array([
      -1, -1, 0, 1,
      1, -1, 1, 1,
      -1, 1, 0, 0,
      -1, 1, 0, 0,
      1, -1, 1, 1,
      1, 1, 1, 0,
    ]);

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(uvLoc);
    gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.webgl = {
      gl,
      program,
      vao,
      texture,
    };

    return true;
  }

  #renderWebGl(videoFrame) {
    if (!this.webgl) {
      return;
    }

    const { gl, program, vao, texture } = this.webgl;

    const canvasWidth = this.canvas.width;
    const canvasHeight = this.canvas.height;
    const videoAspect = this.videoWidth / this.videoHeight;
    const canvasAspect = canvasWidth / canvasHeight;

    let viewportWidth = canvasWidth;
    let viewportHeight = canvasHeight;
    let viewportX = 0;
    let viewportY = 0;

    if (videoAspect > canvasAspect) {
      viewportHeight = Math.floor(canvasWidth / videoAspect);
      viewportY = Math.floor((canvasHeight - viewportHeight) / 2);
    } else {
      viewportWidth = Math.floor(canvasHeight * videoAspect);
      viewportX = Math.floor((canvasWidth - viewportWidth) / 2);
    }

    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.viewport(viewportX, viewportY, viewportWidth, viewportHeight);

    gl.useProgram(program);
    gl.bindVertexArray(vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, videoFrame);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
}
