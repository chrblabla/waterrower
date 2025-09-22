import noble from "@abandonware/noble"

import { SportingDevice, Measurement } from "./index"

export class HeartRateMonitor extends SportingDevice {
  public type: string = "heart_rate_monitor"
  private HEART_RATE_SERVICE_UUID = "180d"
  private HEART_RATE_MEASUREMENT_CHAR_UUID = "2a37"

  public measurements: Measurement[] = [
    { metric: "heart_rate", unit: "bpm", value: 0 }
  ]

  start = async () => {
    noble.on("stateChange", async (state) => {
      if (state === "poweredOn") {
        await noble.startScanningAsync([this.HEART_RATE_SERVICE_UUID], false)
        console.log("Scanning for heart rate monitors…")
      } else {
        await noble.stopScanningAsync()
      }
    })

    noble.on("discover", async (peripheral) => {
      console.log(`Discovered device: ${peripheral.advertisement.localName || peripheral.id}`)
      await noble.stopScanningAsync()
      await peripheral.connectAsync()
      console.log("Connected to device")

      const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [this.HEART_RATE_SERVICE_UUID],
        [this.HEART_RATE_MEASUREMENT_CHAR_UUID]
      )

      const hrChar = characteristics[0]
      hrChar.on("data", (data) => {
        const measurement = this.measurements.find(m => m.metric === "heart_rate")
        if (!measurement) return
        measurement.value = data[1]
        console.log(`Heart Rate: ${measurement.value} bpm`)

        this.publish(measurement)
      })

      await hrChar.subscribeAsync()
      console.log("Subscribed to heart rate notifications")
    })
  }
}
