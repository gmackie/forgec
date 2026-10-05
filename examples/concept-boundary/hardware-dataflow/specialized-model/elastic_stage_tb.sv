module elastic_stage_tb;
  reg clk=0, reset=1, in_valid=0, out_ready=0;
  reg [7:0] in_data=0;
  wire in_ready, out_valid;
  wire [7:0] out_data;
  elastic_stage dut(.*);
  always #5 clk=~clk;
  integer accepted=0, emitted=0, max_occupancy=0;
  reg [7:0] pending;
  reg held=0;
  reg [7:0] held_data;
  always @(posedge clk) begin
    if (!reset) begin
      if (held && (!out_valid || out_data !== held_data)) $fatal(1,"output changed while stalled");
      if (out_valid && out_ready) begin
        if (emitted >= accepted || out_data !== pending) $fatal(1,"loss, duplicate, or reordered sample");
        emitted=emitted+1;
      end
      if (in_valid && in_ready) begin pending=in_data; accepted=accepted+1; end
      if (accepted-emitted > 1 || accepted-emitted < 0) $fatal(1,"invalid occupancy");
      if (accepted-emitted > max_occupancy) max_occupancy=accepted-emitted;
      held=out_valid && !out_ready; held_data=out_data;
    end else held=0;
  end
  task drive(input reg valid, input reg [7:0] data, input reg ready);
    @(negedge clk); in_valid=valid; in_data=data; out_ready=ready;
  endtask
  initial begin
    repeat(2) @(negedge clk); reset=0;
    drive(1,8'h11,0); // accept into empty slot
    drive(1,8'h22,0); // upstream blocked: 22 must not be accepted
    drive(1,8'h22,0); // prolonged stall preserves 11
    drive(1,8'h22,1); // consume 11 and replace it with 22
    drive(1,8'h33,1); // full-rate replacement
    drive(0,0,0);     // stall 33
    drive(0,0,1);     // drain
    drive(0,0,1);
    @(negedge clk);
    if (accepted != 3 || emitted != 3 || out_valid || max_occupancy != 1) $fatal(1,"final conservation mismatch");
    $display("PASS accepted=%0d emitted=%0d maxOccupancy=%0d",accepted,emitted,max_occupancy);
    $finish;
  end
endmodule
