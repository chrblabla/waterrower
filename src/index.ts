// Sporting Device
import mqtt, { MqttClient } from "mqtt"

// Water Rower S4
import { SerialPort } from "serialport"
import { PortInfo } from "@serialport/bindings-interface"

// Heartrate Monitor
import noble from "@abandonware/noble"

// Activity Recorder
import fs from "fs"

// General
type Metric = "distance" | "power" | "total_cycles" | "speed" | "cadence" | "split" | "heart_rate"
type Unit = "m" | "watts" | "cycles" | "m/s" | "spm" | "s/500 m" | "bpm"

type Measurement = {
  value: number,
  unit: Unit,
  metric: Metric
}

interface ISportingDevice {
  type: string
  measurements: Measurement[]
}

// Such as a Heart Rate Monitor or a WaterRower
class SportingDevice implements ISportingDevice {
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

  public stop = () => {
    // To be overridden by subclasses if needed
  }

  public reset = () => {
    // To be overridden by subclasses if needed
  }
}

class WaterRowerS4 extends SportingDevice {
  public type: string = "waterrower"
  private waterRower: PortInfo | null
  private port: SerialPort | null = null
  private lastStrokeTimestamp: EpochTimeStamp | null = null
  private activityTimeout: NodeJS.Timeout | null = null

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

  stop = () => {
    if (this.port) {
      this.port.off("data", this.onData)
    }

    if (this.lastStrokeTimestamp) {
      clearInterval(this.lastStrokeTimestamp)
      this.lastStrokeTimestamp = null
    }
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

  reset = () => {
    if (this.activityTimeout) {
      clearInterval(this.activityTimeout)
      this.activityTimeout = null
    }

    this.send("RST")

    this.measurements.forEach((measurement) => {
      measurement.value = 0
      this.publish(measurement)
    })

    this.lastStrokeTimestamp = null
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

class HeartRateMonitor extends SportingDevice {
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
        // console.log(`Heart Rate: ${measurement.value} bpm`)

        this.publish(measurement)
      })

      await hrChar.subscribeAsync()
      console.log("Subscribed to heart rate notifications")
    })
  }
}

class ActivityRecorder {
  private GARMIN_EPOCH = 631065600
  private recordingInterval: NodeJS.Timeout
  private fitTimestampStart = Math.floor(Date.now() / 1000) - this.GARMIN_EPOCH
  private fileWriter: fs.WriteStream
  private mqttClient: MqttClient

  private sportingDevices: SportingDevice[] = []
  private measurements: Measurement[] = []

  constructor(sportingDevices: SportingDevice[]) {
    this.sportingDevices = sportingDevices
    sportingDevices.forEach((device) => {
      this.measurements.push(...device.measurements)
    })

    // Set up connection to MQTT for the data collection
    this.mqttClient = mqtt.connect("mqtt://localhost")
    this.mqttClient.on("message", (topic: string, payload: Buffer) => {
      const measurement = this.measurements.find(m => topic.endsWith(m.metric))
      const message = payload.toString();

      if (measurement) {
        measurement.value = parseFloat(message)
      }
    })
  }

  start = async () => {
    if (this.recordingInterval) {
      console.log("A recording session is already running.")
      return
    }

    console.log("Starting new session")

    // Subscribe to the topics of all sporting devices
    this.sportingDevices.forEach((device) => {
      device.reset()

      device.measurements.forEach((measurement) => {
        this.mqttClient.subscribe(`${device.type}/${measurement.metric}`, (err) => {
          if (err) {
            console.error("Failed to subscribe to MQTT topic:", err)
          }
        })
      })
    })

    this.openFile()

    this.recordingInterval = setInterval(() => {
      this.record()
    }, 1000) // FIT files have a second-based resolution
  }

  openFile = () => {
    const now = Date.now()
    this.fitTimestampStart = Math.floor(Date.now() / 1000) - this.GARMIN_EPOCH
    this.fileWriter = fs.createWriteStream(`trainings/${now}.fit.csv`)
    this.fileWriter.write("Type,Local Number,Message,Field 1,Value 1,Units 1,Field 2,Value 2,Units 2,Field 3,Value 3,Units 3,Field 4,Value 4,Units 4,Field 5,Value 5,Units 5,Field 6,Value 6,Units 6\n")
    this.fileWriter.write("Definition,0,file_id,serial_number,1,,time_created,1,,manufacturer,1,,type,1,\n")
    this.fileWriter.write(`Data,0,file_id,serial_number,"${this.fitTimestampStart}",,time_created,"${this.fitTimestampStart}",,manufacturer,"118",,type,"4",\n`)
    this.fileWriter.write("Definition,1,record,timestamp,1,,distance,1,,power,1,,cadence,1,,speed,1,,total_cycles,1,,heart_rate,1,,\n")
    this.fileWriter.write("Definition,2,session,timestamp,1,,start_time,1,,total_elapsed_time,1,total_distance,1,,total_cycles,1,,sport,1,,sub_sport,1,\n")
    this.fileWriter.write("Definition,3,activity,timestamp,1,,num_sessions,1,\n")
  }

  stop = () => {
    if (this.recordingInterval) {
      clearInterval(this.recordingInterval)
      this.recordingInterval = null
    }

    console.log("Finalizing workout file")

    const fitTimestampEnd = Math.floor(Date.now() / 1000) - this.GARMIN_EPOCH
    const sessionDuration = fitTimestampEnd - this.fitTimestampStart

    const distance = this.measurements.find(m => m.metric === "distance")
    const strokes = this.measurements.find(m => m.metric === "total_cycles")

    this.fileWriter.write(`Data,2,session,timestamp,\"${this.fitTimestampStart}\",s,start_time,\"${this.fitTimestampStart}\",,`)
    this.fileWriter.write(`total_elapsed_time,\"${sessionDuration}\",s,`)
    this.fileWriter.write(`total_distance,\"${distance.value}\",m,`)
    this.fileWriter.write(`total_cycles,\"${strokes.value}\",cycles,`)
    this.fileWriter.write("sport,\"15\",,sub_sport,\"14\",\n")

    this.fileWriter.write(`Data,3,activity,timestamp,\"${this.fitTimestampStart}\",,num_sessions,\"1\",\n`)
  }

  private record = () => {
    const total_cycles = this.measurements.find(m => m.metric === "total_cycles")
    if (total_cycles && total_cycles.value === 0) {
      console.log("No activity detected yet, skipping data point.")
      return
    }

    const now = Date.now()
    const fitTimestamp = Math.floor(now / 1000) - this.GARMIN_EPOCH

    this.fileWriter.write(`Data,1,record,timestamp,"${fitTimestamp}",s,`)

    // We need to be certain of the order (I think?)
    const measurementIds = ["distance", "power", "total_cycles", "speed", "cadence", "heart_rate"]
    measurementIds.forEach((measurementId) => {
      const measurement = this.measurements.find(m => m.metric === measurementId)
      if (!measurement) {
        console.error(`Measurement ${measurementId} not found.`)
        return
      }
      if (isNaN(measurement.value)) {
        console.error(`Measurement ${measurementId} has invalid value.`)
        return
      }
      this.fileWriter.write(`${measurement.metric},"${measurement.value}",${measurement.unit},`)
    })

    this.fileWriter.write("\n")
  }

  // TODO: reset
}

const heartRateMonitor = new HeartRateMonitor()
await heartRateMonitor.start()

const waterRower = new WaterRowerS4()
await waterRower.start()

const activityRecorder = new ActivityRecorder([heartRateMonitor, waterRower])
await activityRecorder.start()

process.once("SIGINT", () => {
  waterRower.stop()
  heartRateMonitor.stop()
  activityRecorder.stop()
})

// TODO: reset functionality
// if (stringData.startsWith("AKR")) {
//   console.log("\nReset")
//   clearInterval(this.recordingInterval)
//   this.stop(false)
//   this.start()
//   return
// }
