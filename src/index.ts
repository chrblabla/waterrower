import mqtt, { MqttClient } from "mqtt"

import { WaterRowerS4 } from "./waterrowers4"
import { HeartRateMonitor } from "./heartratemonitor"
import { ActivityRecorder } from "./activityrecorder"

// General
export type Metric = "distance" | "power" | "total_cycles" | "speed" | "cadence" | "split" | "heart_rate"
export type Unit = "m" | "watts" | "cycles" | "m/s" | "spm" | "s/500 m" | "bpm"

export type Measurement = {
  value: number,
  unit: Unit,
  metric: Metric
}

interface ISportingDevice {
  type: string
  measurements: Measurement[]
}

// Such as a Heart Rate Monitor or a WaterRower
export class SportingDevice implements ISportingDevice {
  public type: string
  public measurements: Measurement[]
  private mqttClient: MqttClient

  constructor() {
    // Set up connection to MQTT for the dashboard
    this.mqttClient = mqtt.connect("mqtt://localhost")
  }

  public publish = (measurement: Measurement) => {
    this.mqttClient.publish(`${this.type}/${measurement.metric}`, measurement.value.toString())
  }
}

const heartRateMonitor = new HeartRateMonitor()
await heartRateMonitor.start()

const waterRower = new WaterRowerS4()
await waterRower.start()

const activityRecorder = new ActivityRecorder([heartRateMonitor, waterRower])

await activityRecorder.start()

process.once("SIGINT", () => {
  activityRecorder.stop(true)
})

// TODO: reset functionality
// if (stringData.startsWith("AKR")) {
//   console.log("\nReset")
//   clearInterval(this.recordingInterval)
//   this.stop(false)
//   this.start()
//   return
// }
