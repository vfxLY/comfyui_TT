
import { ComfyWorkflow } from '../types';

export const generateFluxWorkflow = (
  prompt: string,
  width: number,
  height: number,
  steps: number,
  useLora: boolean
): ComfyWorkflow => {
  const modelSource = useLora ? ["52", 0] : ["48", 0];
  const clipSource = useLora ? ["52", 1] : ["39", 0];
  const seed = Math.floor(Math.random() * 1000000000000000);

  const workflow: ComfyWorkflow = {
    "9": { "inputs": { "filename_prefix": "z-image", "images": ["43", 0] }, "class_type": "SaveImage", "_meta": { "title": "保存图像" } },
    "39": { "inputs": { "clip_name": "zImage_textEncoder.safetensors", "type": "lumina2", "device": "default" }, "class_type": "CLIPLoader", "_meta": { "title": "加载CLIP" } },
    "40": { "inputs": { "vae_name": "zImage_vae.safetensors" }, "class_type": "VAELoader", "_meta": { "title": "加载VAE" } },
    "41": { "inputs": { "width": width, "height": height, "batch_size": 1 }, "class_type": "EmptySD3LatentImage", "_meta": { "title": "空Latent图像（SD3）" } },
    "42": { "inputs": { "conditioning": ["45", 0] }, "class_type": "ConditioningZeroOut", "_meta": { "title": "条件零化" } },
    "43": { "inputs": { "samples": ["44", 0], "vae": ["40", 0] }, "class_type": "VAEDecode", "_meta": { "title": "VAE解码" } },
    "44": { "inputs": { "seed": seed, "steps": steps, "cfg": 1, "sampler_name": "res_multistep", "scheduler": "simple", "denoise": 1, "model": ["47", 0], "positive": ["45", 0], "negative": ["42", 0], "latent_image": ["41", 0] }, "class_type": "KSampler", "_meta": { "title": "K采样器" } },
    "45": { "inputs": { "text": prompt + "\n", "clip": clipSource }, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP文本编码" } },
    "47": { "inputs": { "shift": 3, "model": modelSource }, "class_type": "ModelSamplingAuraFlow", "_meta": { "title": "采样算法（AuraFlow）" } },
    "48": { "inputs": { "unet_name": "zImage_turbo.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader", "_meta": { "title": "UNet加载器" } }
  };

  if (useLora) {
    workflow["52"] = { "inputs": { "lora_name": "z-image-illustria-01.safetensors", "strength_model": 0.7, "strength_clip": 1, "model": ["48", 0], "clip": ["39", 0] }, "class_type": "LoraLoader", "_meta": { "title": "加载LoRA" } };
  }

  return workflow;
};

export const generateEditWorkflow = (
  prompt: string,
  imageFilename: string,
  steps: number,
  cfg: number
): ComfyWorkflow => {
  const seed = Math.floor(Math.random() * 100000000000000);
  
  return {
    "3": { "inputs": { "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler", "scheduler": "simple", "denoise": 1, "model": ["75", 0], "positive": ["111", 0], "negative": ["110", 0], "latent_image": ["88", 0] }, "class_type": "KSampler", "_meta": { "title": "K采样器" } },
    "8": { "inputs": { "samples": ["3", 0], "vae": ["39", 0] }, "class_type": "VAEDecode", "_meta": { "title": "VAE解码" } },
    "37": { "inputs": { "unet_name": "qwen_image_edit_2509_fp8_e4m3fn.safetensors", "weight_dtype": "default" }, "class_type": "UNETLoader", "_meta": { "title": "UNet加载器" } },
    "38": { 
      "inputs": { 
        "clip_name": "qwen_2.5_vl_7b_fp8_scaled.safetensors", 
        "type": "qwen_image", 
        "device": "cpu" 
      }, 
      "class_type": "CLIPLoader", 
      "_meta": { "title": "加载CLIP" } 
    },
    "39": { "inputs": { "vae_name": "qwen_image_vae.safetensors" }, "class_type": "VAELoader", "_meta": { "title": "加载VAE" } },
    "66": { "inputs": { "shift": 3, "model": ["447", 0] }, "class_type": "ModelSamplingAuraFlow", "_meta": { "title": "采样算法（AuraFlow）" } },
    "75": { "inputs": { "strength": 1, "model": ["66", 0] }, "class_type": "CFGNorm", "_meta": { "title": "CFG归一化" } },
    "78": { "inputs": { "image": imageFilename }, "class_type": "LoadImage", "_meta": { "title": "加载图像" } },
    "88": { "inputs": { "pixels": ["390", 0], "vae": ["39", 0] }, "class_type": "VAEEncode", "_meta": { "title": "VAE编码" } },
    "89": { "inputs": { "lora_name": "Qwen\\qwen-image_nsfw_adv_v1.0.safetensors", "strength_model": 0.5, "model": ["37", 0] }, "class_type": "LoraLoaderModelOnly", "_meta": { "title": "LoRA加载器（仅模型）" } },
    "110": { "inputs": { "prompt": "", "clip": ["38", 0], "vae": ["39", 0], "image1": ["390", 0] }, "class_type": "TextEncodeQwenImageEditPlus", "_meta": { "title": "TextEncodeQwenImageEditPlus" } },
    "111": { "inputs": { "prompt": prompt, "clip": ["38", 0], "vae": ["39", 0], "image1": ["390", 0] }, "class_type": "TextEncodeQwenImageEditPlus", "_meta": { "title": "TextEncodeQwenImageEditPlus" } },
    "390": { "inputs": { "image": ["78", 0], "shift": 3 }, "class_type": "FluxKontextImageScale", "_meta": { "title": "FluxKontextImageScale" } },
    "446": { "inputs": { "filename_prefix": "ComfyUI", "images": ["8", 0] }, "class_type": "SaveImage", "_meta": { "title": "保存图像" } },
    "447": { "inputs": { "lora_name": "Qwen\\Qwen_Snofs_1_2.safetensors", "strength_model": 0.5, "model": ["89", 0] }, "class_type": "LoraLoaderModelOnly", "_meta": { "title": "LoRA加载器（仅模型）" } }
  };
};

/**
 * SeedVR2 图像放大工作流
 */
export const generateUpscaleWorkflow = (imageFilename: string): ComfyWorkflow => {
  return {
    "10": {
      "inputs": {
        "seed": Math.floor(Math.random() * 1000000),
        "resolution": 4096,
        "max_resolution": 4096,
        "batch_size": 1,
        "uniform_batch_size": false,
        "color_correction": "lab",
        "temporal_overlap": 0,
        "prepend_frames": 0,
        "input_noise_scale": 0,
        "latent_noise_scale": 0,
        "offload_device": "cpu",
        "enable_debug": false,
        "image": ["21", 0],
        "dit": ["14", 0],
        "vae": ["13", 0]
      },
      "class_type": "SeedVR2VideoUpscaler",
      "_meta": { "title": "SeedVR2 Video Upscaler" }
    },
    "13": {
      "inputs": {
        "model": "ema_vae_fp16.safetensors",
        "device": "cuda:0",
        "encode_tiled": true,
        "encode_tile_size": 1024,
        "encode_tile_overlap": 128,
        "decode_tiled": true,
        "decode_tile_size": 1024,
        "decode_tile_overlap": 128,
        "tile_debug": "false",
        "offload_device": "cpu",
        "cache_model": false
      },
      "class_type": "SeedVR2LoadVAEModel",
      "_meta": { "title": "SeedVR2 Load VAE" }
    },
    "14": {
      "inputs": {
        "model": "seedvr2_ema_7b_sharp_fp16.safetensors",
        "device": "cuda:0",
        "blocks_to_swap": 36,
        "swap_io_components": false,
        "offload_device": "cpu",
        "cache_model": false,
        "attention_mode": "sdpa"
      },
      "class_type": "SeedVR2LoadDiTModel",
      "_meta": { "title": "SeedVR2 Load DiT" }
    },
    "15": {
      "inputs": {
        "filename_prefix": "Upscale",
        "images": ["10", 0]
      },
      "class_type": "SaveImage",
      "_meta": { "title": "保存图像" }
    },
    "16": {
      "inputs": { "image": imageFilename },
      "class_type": "LoadImage",
      "_meta": { "title": "加载图像" }
    },
    "17": {
      "inputs": {
        "image": ["16", 0],
        "alpha": ["16", 1]
      },
      "class_type": "JoinImageWithAlpha",
      "_meta": { "title": "合并图像Alpha" }
    },
    "21": {
      "inputs": { "image": ["17", 0] },
      "class_type": "FluxKontextImageScale",
      "_meta": { "title": "FluxKontextImageScale" }
    }
  };
};

export const generateSdxlWorkflow = (
  positivePrompt: string,
  negativePrompt: string,
  width: number,
  height: number,
  steps: number,
  cfg: number
): ComfyWorkflow => {
  const seed = Math.floor(Math.random() * 1000000000000000);

  return {
    "5": { "inputs": { "width": width, "height": height, "batch_size": 1 }, "class_type": "EmptyLatentImage", "_meta": { "title": "空Latent图像" } },
    "7": { "inputs": { "text": negativePrompt, "clip": ["31", 1] }, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP文本编码" } },
    "8": { "inputs": { "samples": ["13", 0], "vae": ["20", 2] }, "class_type": "VAEDecode", "_meta": { "title": "VAE解码" } },
    "13": { "inputs": { "add_noise": true, "noise_seed": seed, "cfg": cfg, "model": ["20", 0], "positive": ["51", 0], "negative": ["7", 0], "sampler": ["14", 0], "sigmas": ["29", 0], "latent_image": ["5", 0] }, "class_type": "SamplerCustom", "_meta": { "title": "自定义采样器" } },
    "14": { "inputs": { "sampler_name": "dpmpp_2m" }, "class_type": "KSamplerSelect", "_meta": { "title": "K采样器选择" } },
    "20": { "inputs": { "ckpt_name": "sdxl\\unholyDesireMixSinister_v70.safetensors" }, "class_type": "CheckpointLoaderSimple", "_meta": { "title": "Checkpoint加载器（简易）" } },
    "29": { "inputs": { "scheduler": "karras", "steps": steps, "denoise": 1, "model": ["31", 0] }, "class_type": "BasicScheduler", "_meta": { "title": "基本调度器" } },
    "31": { "inputs": { "lora_name": "sdxl_细节增加\\boring_SDXL_negative_LORA_AutismMix_v1.safetensors", "strength_model": 0.8, "strength_clip": 1, "model": ["20", 0], "clip": ["20", 1] }, "class_type": "LoraLoader", "_meta": { "title": "加载LoRA" } },
    "44": { "inputs": { "images": ["8", 0] }, "class_type": "PreviewImage", "_meta": { "title": "预览图像" } },
    "51": { "inputs": { "text": positivePrompt, "clip": ["31", 1] }, "class_type": "CLIPTextEncode", "_meta": { "title": "CLIP文本编码" } }
  };
};
