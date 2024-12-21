require "csv"

CSV.foreach('trainings/1734012982135.csv', headers: true) do |row|
  time = (row["time"].to_i / 1_000).to_i - 631065600 # Garmin Epoch
  type = row["type"]
  unit = row["unit"]
  value = row["value"].to_i

  # overrides
  if row["type"] == "distance"
    id = 1
  elsif row["type"] == "power"
    id = 2
    unit = "watts"
  elsif row["type"] == "cadence"
    id = 3
  elsif row["type"] == "pace"
    id = 4
    unit = "m/s"
    value /= 100
    type = "speed"
  elsif row["type"] == "strokes"
    id = 5
    unit = "cycles"
    type = "total_cycles"
  else
    next
  end

  puts "Data,#{id},record,timestamp,\"#{time}\",s,#{type},\"#{value}\",#{unit},"
end


# Definition,1,record,timestamp,1,,distance,1,,
# Definition,2,record,timestamp,1,,power,1,,
# Definition,3,record,timestamp,1,,cadence,1,,
# Definition,4,record,timestamp,1,,speed,1,,
# Definition,5,record,timestamp,1,,total_cycles,1,,
# Data,2,record,timestamp,"1734012987280",ms,power,"0",watts,
# Data,5,record,timestamp,"1734012987285",ms,total_cycles,"1",cycles,
# Data,1,record,timestamp,"1734012987779",ms,distance,"0",m,
# Data,4,record,timestamp,"1734012987781",ms,speed,"0",m/s,
