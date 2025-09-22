import { SerialPort } from "serialport"
import { PortInfo } from "@serialport/bindings-interface"

import { SportingDevice, Measurement, Metric } from "./index"

export class WaterRowerS4 extends SportingDevice {
  public type: string = "waterrower"
  private waterRower: PortInfo | null
  private port: SerialPort
  private lastStrokeTimestamp: EpochTimeStamp
  private activityTimeout: NodeJS.Timeout

  public measurements: Measurement[] = [
    { metric: "distance", unit: "m", value: 0 },
    { metric: "power", unit: "watts", value: 0 },
    { metric: "total_cycles", unit: "cycles", value: 0 },
    { metric: "speed", unit: "m/s", value: 0 },
    { metric: "cadence", unit: "spm", value: 0 },
    { metric: "split", unit: "s/500 m", value: 0 }
  ]

  start = async () => {
    if (!this.port) {
      // Set up connection to WaterRower
      this.waterRower = await this.findDevice()

      if (!this.waterRower) {
        console.error("No WaterRower found. Please check the USB connection.")
        return
      }

      this.port = new SerialPort({
        path: this.waterRower.path,
        baudRate: 115200,
      })
    }

    this.measurements.forEach((measurement) => {
      measurement.value = 0
    })

    this.port.on("data", this.onData)

    this.send("USB")
  }

  onData = (data: Buffer) => {
    const stringData = data.toString()

    if (stringData.startsWith("_WR_")) {
      this.send("IV?")
    }

    if (stringData.startsWith("IV4")) {
      const firmwareVersion = stringData.substring(3, 5) + "." + stringData.substring(5, 7)
      console.log("Using WaterRower S4 with firmware version", firmwareVersion)
    }

    // To keep things simple, there's a chain in which data gets queried:
    // Each receival of a stroke start (SS) triggers the following chain:
    // SS -> power -> stroke count
    // Additionally, the following data gets queried every 500 ms and triggers a chain in itself:
    // distance -> pace

    // Detecting Stroke Start to query for power
    if (stringData.startsWith("SS")) {
      this.parseAndPublishData("", "cadence") // calculate and update cadence

      this.send("IRD088") // query for power

      // if this is the first stroke, set timer for querying distance
      if (!this.activityTimeout) {
        this.activityTimeout = setInterval(() => {
          this.send("IRD057") // query for distance
        }, 500)
      }
    }

    // Power in W
    if (stringData.startsWith("IDD088")) {
      this.parseAndPublishData(stringData, "power")
      this.send("IRD140") // query for stroke count
    }

    // Stroke count
    if (stringData.startsWith("IDD140")) {
      this.parseAndPublishData(stringData, "total_cycles")
    }

    // Distance in m
    if (stringData.startsWith("IDD057")) {
      this.parseAndPublishData(stringData, "distance")
      this.send("IRD14A") // query for pace (cm/s avg)
    }

    // Pace in cm/s current avg
    if (stringData.startsWith("IDD14A")) {
      this.parseAndPublishData(stringData, "speed")
    }
  }

  private parseAndPublishData = (data: string, metric: Metric) => {
    const now = Date.now()
    const value = parseInt(data.substring(6, 10), 16) || 0

    if (metric === "distance") {
      const distance = this.measurements.find(m => m.metric === "distance")
      if (!distance) return
      distance.value = value
      this.publish(distance)
    } else if (metric === "power") {
      const power = this.measurements.find(m => m.metric === "power")
      if (!power) return
      power.value = value
      this.publish(power)
    } else if (metric === "cadence") {
      if (this.lastStrokeTimestamp) {
        const msSinceLastStroke = now - this.lastStrokeTimestamp
        const cadence = parseFloat((60 * 1000 / msSinceLastStroke).toFixed(1))

        const cadenceMeasurement = this.measurements.find(m => m.metric === "cadence")
        if (!cadenceMeasurement) return
        cadenceMeasurement.value = cadence
        this.publish(cadenceMeasurement)
      }

      this.lastStrokeTimestamp = now
    } else if (metric === "speed") {
      // Speed is delivered in cm/s which needs to converted to m/s
      const speed = this.measurements.find(m => m.metric === "speed")
      if (!speed) return
      speed.value = value / 100
      this.publish(speed)

      if (value !== 0) {
        // Calculate pace for 500 m
        const secondsPer500m = 50000 / value
        // const pacePer500m = `${Math.floor(secondsPer500m / 60)}:${Math.floor(secondsPer500m % 60).toString().padStart(2, '0')}`

        const split = this.measurements.find(m => m.metric === "split")
        if (!split) return
        // split.value = pacePer500m
        split.value = secondsPer500m
        this.publish(split)
      }
    } else if (metric === "total_cycles") {
      const strokes = this.measurements.find(m => m.metric === "total_cycles")
      if (!strokes) return
      strokes.value = value
      this.publish(strokes)
    }
  }

  private send = (value: string) => {
    if (!this.port) {
      console.log("Communication needs to be initialized first.")
      return
    }

    this.port.write(value + "\r\n")
  }

  private findDevice = async (): Promise<PortInfo> => {
    const devices = await SerialPort.list()

    return devices.find((device) => {
      return device.vendorId === "04d8" && device.productId === "000a"
    })
  }
}
