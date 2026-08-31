import { arch, platform, release } from "node:os";
import si from "systeminformation";
import type { JsonObject } from "./types.js";

export async function captureEnvironment(): Promise<JsonObject> {
  const [cpu, graphics, memory, os] = await Promise.all([
    si.cpu(),
    si.graphics(),
    si.mem(),
    si.osInfo(),
  ]);
  return {
    node: process.version,
    platform: platform(),
    architecture: arch(),
    kernelRelease: release(),
    os: {
      platform: os.platform,
      distro: os.distro,
      release: os.release,
      build: os.build,
      arch: os.arch,
    },
    cpu: {
      manufacturer: cpu.manufacturer,
      brand: cpu.brand,
      physicalCores: cpu.physicalCores,
      logicalCores: cpu.cores,
      baseSpeedGhz: numberOrNull(cpu.speed),
      maxSpeedGhz: numberOrNull(cpu.speedMax),
    },
    memory: {
      totalBytes: memory.total,
    },
    graphics: {
      controllers: graphics.controllers.map((controller) => ({
        model: controller.model,
        vendor: controller.vendor,
        bus: controller.bus,
        vramMiB: numberOrNull(controller.vram),
        driverVersion: controller.driverVersion,
      })),
      displays: graphics.displays.map((display) => ({
        model: display.model,
        connection: display.connection,
        currentResolution: `${display.currentResX}x${display.currentResY}`,
        refreshRateHz: numberOrNull(display.currentRefreshRate),
      })),
    },
  } as JsonObject;
}

function numberOrNull(value: string | number | null | undefined): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
